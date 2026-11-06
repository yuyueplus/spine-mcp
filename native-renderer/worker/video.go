package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type boundedLog struct {
	sync.Mutex
	value []byte
}

func (b *boundedLog) Write(p []byte) (int, error) {
	b.Lock()
	defer b.Unlock()
	b.value = append(b.value, p...)
	if len(b.value) > 32000 {
		b.value = append([]byte(nil), b.value[len(b.value)-32000:]...)
	}
	return len(p), nil
}
func (b *boundedLog) String() string { b.Lock(); defer b.Unlock(); return string(b.value) }

type videoSink struct {
	command *exec.Cmd
	input   io.WriteCloser
	log     boundedLog
	output  string
	network bool
	done    bool
	ctx     context.Context
	frames  chan []byte
	drained chan struct{}
	pumpErr error
}

func EncoderArgs(c Config, output string, overwrite bool) ([]string, error) {
	if c.Width%2 != 0 || c.Height%2 != 0 {
		return nil, errors.New("H264 yuv420p requires even dimensions")
	}
	muxer := "mpegts"
	var extras []string
	if isNetwork(output) {
		u, err := url.Parse(output)
		if err != nil || u.Hostname() == "" || u.Port() == "" {
			return nil, errors.New("SRT output needs a host and port")
		}
		// Retain the sender while buffered tail packets drain at stream close.
		q := u.Query()
		if !q.Has("linger") {
			q.Set("linger", "2")
		}
		if !q.Has("pkt_size") {
			q.Set("pkt_size", "1316")
		}
		u.RawQuery = q.Encode()
		output = u.String()
	} else {
		if strings.Contains(output, "://") {
			return nil, errors.New("only local files and explicit SRT URLs are supported")
		}
		switch strings.ToLower(filepath.Ext(output)) {
		case ".ts":
		case ".mp4":
			muxer = "mp4"
			extras = []string{"-movflags", "+faststart"}
		default:
			return nil, errors.New("output file must end with .ts or .mp4")
		}
	}
	flag := "-n"
	if overwrite {
		flag = "-y"
	}
	a := []string{"-hide_banner", "-nostats", "-nostdin", "-benchmark", flag, "-f", "rawvideo", "-pixel_format", c.Format(), "-video_size", fmt.Sprintf("%dx%d", c.Width, c.Height), "-framerate", strconv.FormatFloat(c.FPS, 'f', -1, 64)}
	if c.Format() == "nv12" {
		a = append(a, "-colorspace", "bt709", "-color_range", "tv")
	}
	a = append(a, "-i", "pipe:0")
	for _, track := range c.Audio {
		if err := track.Validate(); err != nil {
			return nil, err
		}
		if track.Loop {
			a = append(a, "-stream_loop", "-1")
		}
		a = append(a, "-thread_queue_size", "32", "-i", track.File)
	}
	if len(c.Audio) == 0 {
		a = append(a, "-an")
	} else {
		var filters, inputs []string
		for i, track := range c.Audio {
			gain := 1.0
			if track.Gain != nil {
				gain = *track.Gain
			}
			label := fmt.Sprintf("a%d", i)
			filters = append(filters, fmt.Sprintf("[%d:a:0]aresample=48000:async=1:first_pts=0,volume=%s,adelay=%d:all=1,apad[%s]", i+1, strconv.FormatFloat(gain, 'f', -1, 64), track.OffsetMS, label))
			inputs = append(inputs, "["+label+"]")
		}
		filters = append(filters, strings.Join(inputs, "")+fmt.Sprintf("amix=inputs=%d:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:latency=1[aout]", len(c.Audio)))
		a = append(a, "-filter_complex_threads", "1", "-filter_complex", strings.Join(filters, ";"), "-map", "0:v:0", "-map", "[aout]", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-shortest")
	}
	a = append(a, c.Encoder.Args()...)
	a = append(a, "-pix_fmt", "yuv420p", "-bf", "0", "-g", strconv.Itoa(int(c.FPS*2+.5)))
	if c.Format() == "nv12" {
		a = append(a, "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv")
	}
	if len(c.Audio) > 0 && c.Frames > 0 {
		a = append(a, "-t", strconv.FormatFloat(float64(c.Frames)/c.FPS, 'f', 6, 64))
	}
	a = append(a, extras...)
	a = append(a, "-f", muxer, output)
	return a, nil
}
func RedactOutput(output string) string {
	if !isNetwork(output) {
		return output
	}
	u, err := url.Parse(output)
	if err != nil {
		return "srt://[invalid]"
	}
	u.User = nil
	q := u.Query()
	for _, key := range []string{"passphrase", "pbkeylen", "streamid"} {
		if q.Has(key) {
			q.Set(key, "[redacted]")
		}
	}
	u.RawQuery = q.Encode()
	return u.String()
}
func newVideoSink(ctx context.Context, c Config, o Options) (*videoSink, error) {
	args, err := EncoderArgs(c, o.Output, o.Overwrite)
	if err != nil {
		return nil, err
	}
	if !isNetwork(o.Output) {
		if !o.Overwrite {
			if _, err := os.Stat(o.Output); err == nil {
				return nil, errors.New("output exists; use another path or explicitly enable overwrite")
			} else if !os.IsNotExist(err) {
				return nil, err
			}
		}
		if err = os.MkdirAll(filepath.Dir(o.Output), 0755); err != nil {
			return nil, err
		}
	}
	ffmpeg := o.FFmpeg
	if ffmpeg == "" {
		ffmpeg = "ffmpeg"
	}
	for _, track := range c.Audio {
		if st, err := os.Stat(track.File); err != nil || !st.Mode().IsRegular() {
			return nil, errors.New("audio input is not a readable regular local file")
		}
	}
	s := &videoSink{output: o.Output, network: isNetwork(o.Output), ctx: ctx}
	s.command = exec.CommandContext(ctx, ffmpeg, args...)
	hideProcess(s.command)
	s.command.WaitDelay = 5 * time.Second
	s.command.Stderr = &s.log
	s.input, err = s.command.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err = s.command.Start(); err != nil {
		s.input.Close()
		return nil, err
	}
	if c.QueueFrames > 0 {
		s.frames = make(chan []byte, c.QueueFrames)
		s.drained = make(chan struct{})
		go func() {
			defer close(s.drained)
			for p := range s.frames {
				if s.pumpErr = s.writeRaw(p); s.pumpErr != nil {
					return
				}
			}
		}()
	}
	return s, nil
}
func (s *videoSink) Write(p []byte) error {
	if s.frames != nil {
		// Native storage is reused by the next Step. Queue only owned Go bytes.
		owned := append([]byte(nil), p...)
		select {
		case <-s.ctx.Done():
			return s.ctx.Err()
		case <-s.drained:
			return s.pumpErr
		case s.frames <- owned:
			return nil
		}
	}
	return s.writeRaw(p)
}
func (s *videoSink) writeRaw(p []byte) error {
	for len(p) > 0 {
		n, err := s.input.Write(p)
		if err != nil {
			return fmt.Errorf("encoder input: %w", err)
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		p = p[n:]
	}
	return nil
}
func (s *videoSink) Close() error {
	if s.done {
		return nil
	}
	s.done = true
	if s.frames != nil {
		close(s.frames)
		<-s.drained
	}
	s.input.Close()
	err := s.command.Wait()
	if s.pumpErr != nil {
		err = errors.Join(err, s.pumpErr)
	}
	if err != nil {
		detail := s.log.String()
		if s.network {
			detail = "Check SRT destination and worker encoder log"
		}
		return fmt.Errorf("FFmpeg failed: %w: %s", err, detail)
	}
	return nil
}
func (s *videoSink) Abort() {
	if !s.done {
		s.command.Process.Kill()
		_ = s.Close()
	}
}

type Probe struct {
	Mode    string `json:"mode"`
	Streams []struct {
		Width   int    `json:"width"`
		Height  int    `json:"height"`
		Codec   string `json:"codec_name"`
		FPS     string `json:"avg_frame_rate"`
		Frames  string `json:"nb_read_frames"`
		Packets string `json:"nb_read_packets"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
		Size     string `json:"size"`
	} `json:"format"`
}

func verifyVideo(ctx context.Context, tool, output string, c Config, frames int) (*Probe, error) {
	if tool == "" {
		tool = "ffprobe"
	}
	count := "-count_frames"
	if c.Verification == "packets" {
		count = "-count_packets"
	}
	cmd := exec.CommandContext(ctx, tool, "-v", "error", count, "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name,avg_frame_rate,nb_read_frames,nb_read_packets:format=duration,size", "-of", "json", output)
	hideProcess(cmd)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ffprobe: %w: %s", err, out.String())
	}
	var p Probe
	if err := json.Unmarshal(out.Bytes(), &p); err != nil {
		return nil, err
	}
	if len(p.Streams) != 1 {
		return nil, errors.New("expected one video stream")
	}
	v := p.Streams[0]
	p.Mode = "decoded_frames"
	value := v.Frames
	if c.Verification == "packets" {
		p.Mode = "encoded_packets"
		value = v.Packets
	}
	n, err := strconv.Atoi(value)
	if err != nil || n != frames || v.Width != c.Width || v.Height != c.Height || v.Codec != "h264" {
		return nil, fmt.Errorf("encoded frame count/format mismatch: %+v", v)
	}
	return &p, nil
}
