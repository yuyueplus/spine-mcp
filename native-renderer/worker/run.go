package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/yuyueplus/spine-mcp/native-renderer/internal/native"
	"path/filepath"
	"runtime"
	"sort"
	"time"
)

type Info = native.Info
type Command = native.Command
type Response struct {
	ID             json.RawMessage `json:"id,omitempty"`
	AppliedAtFrame int             `json:"appliedAtFrame"`
	Result         map[string]any  `json:"result,omitempty"`
	Error          string          `json:"error,omitempty"`
}
type Request struct {
	Command Command
	Reply   chan<- Response
}
type Event struct {
	Event            string    `json:"event"`
	Info             *Info     `json:"info,omitempty"`
	Response         *Response `json:"response,omitempty"`
	Frames           int       `json:"frames,omitempty"`
	InitializationMS float64   `json:"initializationMs,omitempty"`
	Message          string    `json:"message,omitempty"`
}
type engine interface {
	Info() (native.Info, error)
	Step(uint32, bool) (native.Frame, error)
	Command(native.Command) (map[string]any, error)
	Close() error
}
type Options struct {
	Library, Output, FFmpeg, FFprobe string
	Overwrite                        bool
	SkipVerification                 bool
	Requests                         <-chan Request
	OnEvent                          func(Event) error
	OnFrame                          func(index int, pixels []byte, info Info) error
	factory                          func(string, string, Config) (engine, error)
}
type Stats struct {
	MeanMS float64 `json:"meanMs"`
	P95MS  float64 `json:"p95Ms"`
	MaxMS  float64 `json:"maxMs"`
}
type Report struct {
	Version          string           `json:"version"`
	Info             Info             `json:"info"`
	Frames           int              `json:"frames"`
	Reason           string           `json:"reason"`
	Paced            bool             `json:"paced"`
	FPS              float64          `json:"targetFps"`
	DeadlineMisses   int              `json:"deadlineMisses"`
	InitializationMS float64          `json:"initializationMs"`
	RenderWallMS     float64          `json:"renderWallMs"`
	TotalWallMS      float64          `json:"totalWallMs"`
	ThroughputFPS    float64          `json:"throughputFps"`
	Vertices         uint32           `json:"vertices"`
	Triangles        uint32           `json:"triangles"`
	DrawBatches      uint32           `json:"drawBatches"`
	Timing           map[string]Stats `json:"timing"`
	GoHeapSamples    []uint64         `json:"goHeapSamplesBytes"`
	Encoded          *Encoding        `json:"encoding,omitempty"`
	Passed           bool             `json:"passed"`
}
type Encoding struct {
	Output          string      `json:"output"`
	Codec           string      `json:"codec"`
	Frames          int         `json:"frames"`
	HardwareEncoder bool        `json:"hardwareEncoder"`
	AudioIncluded   bool        `json:"audioIncluded"`
	NetworkOutput   bool        `json:"networkOutput"`
	Probe           *Probe      `json:"probe,omitempty"`
	EncoderLog      string      `json:"encoderLog,omitempty"`
	AudioProbe      *AudioProbe `json:"audioProbe,omitempty"`
}

func stats(values []float64) Stats {
	if len(values) == 0 {
		return Stats{}
	}
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	s := append([]float64(nil), values...)
	sort.Float64s(s)
	return Stats{sum / float64(len(s)), s[len(s)*95/100], s[len(s)-1]}
}
func durationMS(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

// Run owns a locked OS thread for the entire cgo renderer lifetime. Other
// goroutines submit controls through Requests; they never call bgfx directly.
// Run this inside a dedicated worker process to isolate native driver failures.
func Run(ctx context.Context, c Config, o Options) (report Report, err error) {
	if err = c.Validate(); err != nil {
		return report, err
	}
	if o.Output != "" && !c.EmitFrames {
		return report, errors.New("encoding requires emitFrames=true")
	}
	if o.Output != "" {
		if _, err = EncoderArgs(c, o.Output, o.Overwrite); err != nil {
			return report, err
		}
		if c.Encoder.Hardware() {
			if err = ProbeEncoder(ctx, o.FFmpeg, c.Encoder); err != nil {
				return report, err
			}
		}
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	start := time.Now()
	report.Version = "0.2.0"
	report.Paced = c.Paced
	report.FPS = c.FPS
	defer func() {
		report.TotalWallMS = durationMS(time.Since(start))
		if report.TotalWallMS > 0 {
			report.ThroughputFPS = float64(report.Frames) * 1000 / report.TotalWallMS
		}
	}()
	if err = ctx.Err(); err != nil {
		return report, err
	}
	library := o.Library
	if library == "" {
		library = DefaultLibrary()
	}
	library, err = filepath.Abs(library)
	if err != nil {
		return report, err
	}
	shaders := c.Shaders
	if shaders == "" {
		shaders = filepath.Join(filepath.Dir(library), "shaders")
	}
	var e engine
	if o.factory != nil {
		e, err = o.factory(library, shaders, c)
	} else {
		e, err = native.Open(library, shaders, c)
	}
	if err != nil {
		return report, err
	}
	closed := false
	defer func() {
		if !closed {
			err = errors.Join(err, e.Close())
		}
	}()
	report.Info, err = e.Info()
	if err != nil {
		return report, err
	}
	if report.Info.Width != c.Width || report.Info.Height != c.Height || report.Info.PixelFormat != c.Format() || report.Info.RowStride != c.Stride() || !report.Info.Offscreen || report.Info.NativeWindow {
		return report, errors.New("native renderer metadata does not match requested offscreen format")
	}
	for i := 0; i < c.Warmup; i++ {
		if err = ctx.Err(); err != nil {
			return report, err
		}
		if _, err = e.Step(uint32(i), false); err != nil {
			return report, err
		}
	}
	report.InitializationMS = durationMS(time.Since(start))
	emit := func(event Event) error {
		if o.OnEvent != nil {
			return o.OnEvent(event)
		}
		return nil
	}
	if err = emit(Event{Event: "ready", Info: &report.Info, InitializationMS: report.InitializationMS}); err != nil {
		return report, err
	}
	var sink *videoSink
	defer func() {
		if sink != nil {
			sink.Abort()
		}
	}()
	var frameTimes, prepares, reads, writes []float64
	requests := o.Requests
	shutdown := false
	renderStart := time.Now()
	interval := time.Duration(float64(time.Second) / c.FPS)
	for !shutdown && (c.Frames == 0 || report.Frames < c.Frames) {
		if err = ctx.Err(); err != nil {
			report.Reason = "cancelled"
			return report, err
		}
		for pending := 0; pending < 64; pending++ {
			select {
			case request, ok := <-requests:
				if !ok {
					requests = nil
					break
				}
				response := Response{ID: request.Command.ID, AppliedAtFrame: report.Frames}
				response.Result, err = e.Command(request.Command)
				if err != nil {
					response.Error = err.Error()
					err = nil
				} else if stopping, _ := response.Result["stopping"].(bool); stopping {
					shutdown = true
				}
				if request.Reply != nil {
					select {
					case request.Reply <- response:
					default:
					}
				}
				if err = emit(Event{Event: "response", Response: &response}); err != nil {
					return report, err
				}
			default:
				pending = 64
			}
		}
		if shutdown {
			break
		}
		deadline := renderStart.Add(time.Duration(float64(report.Frames) * float64(time.Second) / c.FPS))
		if c.Paced {
			if wait := time.Until(deadline); wait > 0 {
				timer := time.NewTimer(wait)
				select {
				case <-ctx.Done():
					timer.Stop()
					report.Reason = "cancelled"
					return report, ctx.Err()
				case <-timer.C:
				}
			}
		}
		begin := time.Now()
		frame, stepErr := e.Step(uint32(report.Frames+c.Warmup), c.EmitFrames)
		if stepErr != nil {
			return report, stepErr
		}
		if c.EmitFrames && len(frame.Pixels) != c.FrameBytes() {
			return report, errors.New("native frame size does not match resolution")
		}
		writeStart := time.Now()
		if sink == nil && o.Output != "" {
			sink, err = newVideoSink(ctx, c, o)
			if err != nil {
				return report, err
			}
		}
		if sink != nil {
			if err = sink.Write(frame.Pixels); err != nil {
				return report, err
			}
		}
		if o.OnFrame != nil && c.EmitFrames {
			if err = o.OnFrame(report.Frames, frame.Pixels, report.Info); err != nil {
				return report, err
			}
		}
		end := time.Now()
		frameTimes = append(frameTimes, durationMS(end.Sub(begin)))
		prepares = append(prepares, frame.PrepareMS)
		reads = append(reads, frame.ReadbackMS)
		writes = append(writes, durationMS(end.Sub(writeStart)))
		if len(frameTimes) >= 100000 {
			frameTimes = append([]float64(nil), frameTimes[50000:]...)
			prepares = append([]float64(nil), prepares[50000:]...)
			reads = append([]float64(nil), reads[50000:]...)
			writes = append([]float64(nil), writes[50000:]...)
		}
		if c.Paced && end.After(deadline.Add(interval)) {
			report.DeadlineMisses++
		}
		report.Frames++
		report.Vertices = frame.Vertices
		report.Triangles = frame.Triangles
		report.DrawBatches = frame.Batches
		if report.Frames%300 == 0 {
			if len(report.GoHeapSamples) < 1000 {
				var m runtime.MemStats
				runtime.ReadMemStats(&m)
				report.GoHeapSamples = append(report.GoHeapSamples, m.HeapAlloc)
			}
			if err = emit(Event{Event: "progress", Frames: report.Frames}); err != nil {
				return report, err
			}
		}
	}
	report.RenderWallMS = durationMS(time.Since(renderStart))
	report.Reason = "frame-limit"
	if shutdown {
		report.Reason = "shutdown"
	}
	report.Timing = map[string]Stats{"frame": stats(frameTimes), "prepare": stats(prepares), "readback": stats(reads), "encoderAndConsumer": stats(writes)}
	if sink != nil {
		if err = sink.Close(); err != nil {
			return report, err
		}
		report.Encoded = &Encoding{Output: RedactOutput(o.Output), Codec: c.Encoder.Name(), HardwareEncoder: c.Encoder.Hardware(), AudioIncluded: len(c.Audio) > 0, Frames: report.Frames, NetworkOutput: sink.network}
		if !sink.network {
			report.Encoded.EncoderLog = sink.log.String()
			if !o.SkipVerification {
				report.Encoded.Probe, err = verifyVideo(ctx, o.FFprobe, o.Output, c, report.Frames)
				if err != nil {
					return report, err
				}
				if len(c.Audio) > 0 {
					report.Encoded.AudioProbe, err = verifyAudio(ctx, o.FFprobe, o.Output, c, report.Frames)
					if err != nil {
						return report, err
					}
				}
			}
		}
	}
	if err = e.Close(); err != nil {
		return report, fmt.Errorf("native shutdown: %w", err)
	}
	closed = true
	report.Passed = true
	if err = emit(Event{Event: "complete", Frames: report.Frames}); err != nil {
		report.Passed = false
		return report, err
	}
	return report, nil
}
