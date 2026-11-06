package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/yuyueplus/spine-mcp/native-renderer/worker"
	"image"
	"image/png"
	"io"
	"math"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var clips = []string{"01_idle_breeze", "02_greeting_wave", "03_charge_release", "05_jump_land_review", "06_greeting_wave_emphasis"}
var samples = []int{45, 135, 225, 315, 405}

func save(file string, value any) error {
	b, e := json.MarshalIndent(value, "", "  ")
	if e != nil {
		return e
	}
	return os.WriteFile(file, append(b, '\n'), 0644)
}
func hashes(dir string) (map[string]string, error) {
	result := map[string]string{}
	files, e := os.ReadDir(dir)
	if e != nil {
		return nil, e
	}
	for _, file := range files {
		if file.IsDir() {
			continue
		}
		switch strings.ToLower(filepath.Ext(file.Name())) {
		case ".spine", ".json", ".skel", ".png", ".atlas":
		default:
			continue
		}
		f, e := os.Open(filepath.Join(dir, file.Name()))
		if e != nil {
			return nil, e
		}
		h := sha256.New()
		_, e = io.Copy(h, f)
		f.Close()
		if e != nil {
			return nil, e
		}
		result[file.Name()] = hex.EncodeToString(h.Sum(nil))
	}
	return result, nil
}
func pngFrame(file string, pixels []byte, w, h int) error {
	f, e := os.Create(file)
	if e != nil {
		return e
	}
	e = png.Encode(f, &image.NRGBA{Pix: pixels, Stride: w * 4, Rect: image.Rect(0, 0, w, h)})
	closeErr := f.Close()
	if e != nil {
		return e
	}
	return closeErr
}
func compare(file, reference string) (map[string]any, error) {
	load := func(file string) (image.Image, error) {
		f, e := os.Open(file)
		if e != nil {
			return nil, e
		}
		defer f.Close()
		return png.Decode(f)
	}
	a, e := load(file)
	if e != nil {
		return nil, e
	}
	b, e := load(reference)
	if e != nil {
		return nil, e
	}
	if a.Bounds() != b.Bounds() {
		return nil, errors.New("reference image dimensions differ")
	}
	bg := [3]int{29, 36, 52}
	sum, foregroundSum := 0.0, 0.0
	union, intersection := 0, 0
	for y := a.Bounds().Min.Y; y < a.Bounds().Max.Y; y++ {
		for x := a.Bounds().Min.X; x < a.Bounds().Max.X; x++ {
			r, g, blue, _ := a.At(x, y).RGBA()
			r2, g2, b2, _ := b.At(x, y).RGBA()
			ca := [3]int{int(r >> 8), int(g >> 8), int(blue >> 8)}
			cb := [3]int{int(r2 >> 8), int(g2 >> 8), int(b2 >> 8)}
			fa, fb := false, false
			delta := 0.0
			for c := 0; c < 3; c++ {
				delta += math.Abs(float64(ca[c] - cb[c]))
				fa = fa || math.Abs(float64(ca[c]-bg[c])) > 8
				fb = fb || math.Abs(float64(cb[c]-bg[c])) > 8
			}
			sum += delta
			if fa || fb {
				union++
				foregroundSum += delta
			}
			if fa && fb {
				intersection++
			}
		}
	}
	if union == 0 {
		return nil, errors.New("blank comparison image")
	}
	iou := float64(intersection) / float64(union)
	mae := foregroundSum / float64(union*3)
	result := map[string]any{"image": file, "reference": reference, "foregroundIoU": iou, "foregroundMeanAbsoluteRgbErrorOutOf255": mae, "fullImageMeanAbsoluteRgbErrorOutOf255": sum / float64(a.Bounds().Dx()*a.Bounds().Dy()*3)}
	if iou < .99 || mae > 2 {
		return result, fmt.Errorf("visual comparison failed: IoU %.6f MAE %.3f", iou, mae)
	}
	return result, nil
}
func runLoopback(ctx context.Context, c worker.Config, o worker.Options, dir string) (map[string]any, error) {
	listener, e := net.ListenPacket("udp", "127.0.0.1:0")
	if e != nil {
		return nil, e
	}
	port := listener.LocalAddr().(*net.UDPAddr).Port
	listener.Close()
	output := filepath.Join(dir, "srt-received.ts")
	receiverLog, err := os.Create(filepath.Join(dir, "srt-receiver.log"))
	if err != nil {
		return nil, err
	}
	defer receiverLog.Close()
	address := fmt.Sprintf("srt://127.0.0.1:%d?mode=listener&latency=100000&listen_timeout=10000000&timeout=10000000", port)
	cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-y", "-i", address, "-an", "-c:v", "copy", "-f", "mpegts", output)
	cmd.Stderr = receiverLog
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	defer func() {
		if cmd.ProcessState == nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
	}()
	select {
	case <-time.After(250 * time.Millisecond):
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	c.Frames = 90
	c.Paced = true
	c.EmitFrames = true
	o.Output = fmt.Sprintf("srt://127.0.0.1:%d?mode=caller&pkt_size=1316&latency=100000&linger=1", port)
	report, err := worker.Run(ctx, c, o)
	if err != nil {
		return nil, err
	}
	finished := make(chan error, 1)
	go func() { finished <- cmd.Wait() }()
	var receiveErr error
	select {
	case receiveErr = <-finished:
	case <-time.After(15 * time.Second):
		cmd.Process.Kill()
		<-finished
		return nil, errors.New("SRT receiver did not finish")
	}
	probe, e := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,codec_name,width,height", "-of", "json", output).Output()
	if e != nil {
		return nil, e
	}
	var parsed struct {
		Streams []struct {
			Frames string `json:"nb_read_frames"`
			Codec  string `json:"codec_name"`
			Width  int    `json:"width"`
			Height int    `json:"height"`
		} `json:"streams"`
	}
	if e = json.Unmarshal(probe, &parsed); e != nil {
		return nil, e
	}
	if len(parsed.Streams) != 1 || parsed.Streams[0].Frames != strconv.Itoa(c.Frames) {
		return nil, fmt.Errorf("SRT decoded frame mismatch: %s", probe)
	}
	// FFmpeg's SRT demuxer may report I/O error when the sender closes normally;
	// exact decoded frame count is the independent delivery check.
	return map[string]any{"passed": true, "scope": "localhost only", "report": report, "receiverExit": fmt.Sprint(receiveErr), "probe": json.RawMessage(probe), "receivedFile": output}, nil
}
func main() {
	sourceFlag := flag.String("source", "", "directory with the five-animation acceptance character")
	library := flag.String("native", "", "native renderer library")
	renderer := flag.String("renderer", "auto", "bgfx backend (auto, d3d12, vulkan, metal, d3d11, opengl)")
	outFlag := flag.String("out", "", "new acceptance output directory")
	references := flag.String("references", "", "directory of official CanvasKit reference-frame PNGs")
	longFrames := flag.Int("paced-frames", 3600, "30fps sustained test frames")
	loopback := flag.Bool("srt-loopback", true, "verify SRT delivery on 127.0.0.1 only")
	flag.Parse()
	fail := func(e error) {
		if e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(1)
		}
	}
	if *sourceFlag == "" {
		fail(errors.New("-source is required"))
	}
	source, e := filepath.Abs(*sourceFlag)
	fail(e)
	out := *outFlag
	if out == "" {
		out = filepath.Join("output", "acceptance-"+time.Now().Format("20060102-150405"))
	}
	out, e = filepath.Abs(out)
	fail(e)
	fail(os.MkdirAll(out, 0755))
	if _, e = os.Stat(filepath.Join(out, "summary.json")); e == nil {
		fail(errors.New("summary exists; use a new output directory"))
	}
	pins, e := hashes(source)
	fail(e)
	c := worker.DefaultConfig()
	c.Renderer = *renderer
	c.Skeleton = filepath.Join(source, "skeleton.skel")
	c.Atlas = filepath.Join(source, "skeleton.atlas")
	c.Playlist = clips
	c.Frames = 450
	c.Paced = false
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	summary := map[string]any{"at": time.Now().UTC(), "go": runtime.Version(), "platform": runtime.GOOS, "arch": runtime.GOARCH, "source": source, "originalHashes": pins, "resolution": []int{1280, 720}, "msaa": 4, "requestedBackend": c.Renderer, "reports": map[string]worker.Report{}, "limitations": []string{"Local machine/GPU only; other target systems need their own GPU acceptance.", "Short single-room runs, not 24/7 or multi-room certification.", "Software H264 video only; no audio, hardware encoder or GPU encoder zero-copy.", "Optional SRT test uses localhost only; no EEAI service, remote database, CDN or browser playback was accessed."}}
	reports := summary["reports"].(map[string]worker.Report)
	for _, mode := range []string{"gpu", "pipeline", "paced"} {
		config := c
		config.EmitFrames = mode != "gpu"
		config.Paced = mode == "paced"
		if config.Paced {
			config.Frames = *longFrames
		}
		captured := map[int][]byte{}
		options := worker.Options{Library: *library, Overwrite: false}
		if mode != "gpu" {
			options.Output = filepath.Join(out, mode+".ts")
		}
		if mode == "pipeline" {
			options.OnFrame = func(i int, p []byte, _ worker.Info) error {
				for _, sample := range samples {
					if i+c.Warmup == sample {
						captured[sample] = append([]byte(nil), p...)
					}
				}
				return nil
			}
		}
		fmt.Printf("Starting %s (%d frames)\n", mode, config.Frames)
		report, err := worker.Run(ctx, config, options)
		fail(err)
		reports[mode] = report
		fail(save(filepath.Join(out, mode+".json"), report))
		fmt.Printf("%s: %d frames, render/delivery %.2f fps, total %.2f fps, deadline misses %d\n", mode, report.Frames, float64(report.Frames)*1000/report.RenderWallMS, report.ThroughputFPS, report.DeadlineMisses)
		for index, pixels := range captured {
			fail(pngFrame(filepath.Join(out, fmt.Sprintf("frame-%d.png", index)), pixels, 1280, 720))
		}
		fail(save(filepath.Join(out, "progress.json"), summary))
	}
	if *references != "" {
		var comparisons []map[string]any
		for _, index := range samples {
			comparison, err := compare(filepath.Join(out, fmt.Sprintf("frame-%d.png", index)), filepath.Join(*references, fmt.Sprintf("reference-1280x720-frame-%d.png", index)))
			comparisons = append(comparisons, comparison)
			fail(err)
		}
		summary["visualComparisons"] = comparisons
	}
	if *loopback {
		fmt.Println("Starting localhost SRT verification")
		result, err := runLoopback(ctx, c, worker.Options{Library: *library}, out)
		fail(err)
		summary["srtLoopback"] = result
	}
	after, e := hashes(source)
	fail(e)
	if !reflect.DeepEqual(pins, after) {
		fail(errors.New("source assets changed during acceptance"))
	}
	summary["sourceFilesUnchanged"] = true
	if reports["paced"].Timing["frame"].P95MS > 1000/c.FPS {
		fail(errors.New("paced p95 frame processing exceeds frame budget"))
	}
	summary["passed"] = true
	fail(save(filepath.Join(out, "summary.json"), summary))
	fmt.Println("Acceptance passed:", filepath.Join(out, "summary.json"))
}
