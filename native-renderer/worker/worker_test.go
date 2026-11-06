package worker

import (
	"context"
	"errors"
	"github.com/yuyueplus/spine-mcp/native-renderer/internal/native"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeEngine struct {
	info          native.Info
	calls, closed int
	badFrame      bool
	failStep      bool
}

func (f *fakeEngine) Info() (native.Info, error) { return f.info, nil }
func (f *fakeEngine) Step(_ uint32, capture bool) (native.Frame, error) {
	f.calls++
	if f.failStep {
		return native.Frame{}, errors.New("device failed")
	}
	var pixels []byte
	if capture {
		pixels = make([]byte, f.info.Width*f.info.Height*4)
		if f.badFrame {
			pixels = pixels[:4]
		}
	}
	return native.Frame{Pixels: pixels, Triangles: 2, Batches: 1}, nil
}
func (f *fakeEngine) Command(c native.Command) (map[string]any, error) {
	if c.Method == "bad" {
		return nil, errors.New("unknown animation")
	}
	return map[string]any{"stopping": c.Method == "shutdown"}, nil
}
func (f *fakeEngine) Close() error { f.closed++; return nil }
func fixture() (Config, *fakeEngine, Options) {
	c := DefaultConfig()
	c.Skeleton = "skeleton.skel"
	c.Atlas = "skeleton.atlas"
	c.Width = 64
	c.Height = 64
	c.Frames = 4
	c.Warmup = 1
	c.Paced = false
	f := &fakeEngine{info: native.Info{Width: 64, Height: 64, RowStride: 256, PixelFormat: "rgba", Offscreen: true}}
	o := Options{factory: func(string, string, Config) (engine, error) { return f, nil }}
	return c, f, o
}
func TestRunClosesAndCountsFrames(t *testing.T) {
	c, f, o := fixture()
	seen := 0
	o.OnFrame = func(i int, p []byte, _ Info) error {
		if i != seen || len(p) != 64*64*4 {
			t.Fatal("frame order/storage")
		}
		seen++
		return nil
	}
	r, e := Run(context.Background(), c, o)
	if e != nil || !r.Passed || r.Frames != 4 || seen != 4 || f.calls != 5 || f.closed != 1 {
		t.Fatalf("result=%+v err=%v native=%+v", r, e, f)
	}
}
func TestRunReleasesNativeOnConsumerFailure(t *testing.T) {
	c, f, o := fixture()
	o.OnFrame = func(int, []byte, Info) error { return errors.New("consumer failed") }
	_, e := Run(context.Background(), c, o)
	if e == nil || f.closed != 1 {
		t.Fatalf("err=%v closed=%d", e, f.closed)
	}
}
func TestRunRejectsMalformedFrame(t *testing.T) {
	c, f, o := fixture()
	f.badFrame = true
	_, e := Run(context.Background(), c, o)
	if e == nil || f.closed != 1 {
		t.Fatalf("err=%v closed=%d", e, f.closed)
	}
}
func TestRunReleasesNativeOnDeviceFailure(t *testing.T) {
	c, f, o := fixture()
	f.failStep = true
	_, e := Run(context.Background(), c, o)
	if e == nil || f.closed != 1 {
		t.Fatalf("err=%v closed=%d", e, f.closed)
	}
}
func TestCommandsFailIndependentlyAndShutdown(t *testing.T) {
	c, f, o := fixture()
	queue := make(chan Request, 2)
	reply := make(chan Response, 2)
	queue <- Request{Command: Command{Method: "bad"}, Reply: reply}
	queue <- Request{Command: Command{Method: "shutdown"}, Reply: reply}
	close(queue)
	o.Requests = queue
	r, e := Run(context.Background(), c, o)
	a, b := <-reply, <-reply
	if e != nil || r.Reason != "shutdown" || r.Frames != 0 || a.Error == "" || b.Error != "" || b.AppliedAtFrame != 0 || f.closed != 1 {
		t.Fatalf("%+v %+v %+v %v", r, a, b, e)
	}
}
func TestClosedCommandsDoNotBlockRendering(t *testing.T) {
	c, _, o := fixture()
	q := make(chan Request)
	close(q)
	o.Requests = q
	r, e := Run(context.Background(), c, o)
	if e != nil || r.Frames != c.Frames {
		t.Fatal(r, e)
	}
}
func TestCancellationBeforeNativeStartup(t *testing.T) {
	c, f, o := fixture()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, e := Run(ctx, c, o)
	if !errors.Is(e, context.Canceled) || f.calls != 0 || f.closed != 0 {
		t.Fatal(e, f)
	}
}
func TestConfigRejectsInvalidBounds(t *testing.T) {
	for _, change := range []func(*Config){func(c *Config) { c.Width = 0 }, func(c *Config) { c.FPS = 0 }, func(c *Config) { c.Frames = -1 }, func(c *Config) { c.MSAA = 8 }, func(c *Config) { c.Renderer = "software" }, func(c *Config) { c.ClipFrames = 0 }} {
		c, _, _ := fixture()
		change(&c)
		if c.Validate() == nil {
			t.Fatal("accepted invalid config")
		}
	}
}
func TestConfigPathsResolveAgainstConfigFile(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "session.json")
	if e := os.WriteFile(file, []byte(`{"skeleton":"assets/hero.skel","atlas":"assets/hero.atlas"}`), 0600); e != nil {
		t.Fatal(e)
	}
	c, e := LoadConfig(file)
	if e != nil || c.Skeleton != filepath.Join(dir, "assets", "hero.skel") || !c.Paced || !c.EmitFrames || c.FPS != 30 {
		t.Fatal(c, e)
	}
}
func TestEncoderArgsAndRedaction(t *testing.T) {
	c, _, _ := fixture()
	url := "srt://127.0.0.1:9999?passphrase=secret&streamid=room123"
	args, e := EncoderArgs(c, url, false)
	if e != nil || args[len(args)-2] != "mpegts" || !strings.Contains(args[len(args)-1], "linger=2") || !strings.Contains(args[len(args)-1], "pkt_size=1316") || !strings.Contains(args[len(args)-1], "passphrase=secret") {
		t.Fatal(args, e)
	}
	redacted := RedactOutput(url)
	if strings.Contains(redacted, "secret") || strings.Contains(redacted, "room123") {
		t.Fatal(redacted)
	}
	if _, e = EncoderArgs(c, "https://example.com/upload", false); e == nil {
		t.Fatal("accepted unsupported network protocol")
	}
	c.Width = 65
	if _, e = EncoderArgs(c, "a.mp4", false); e == nil {
		t.Fatal("accepted odd video dimensions")
	}
}
func TestEncodingCannotUseRenderOnlyMode(t *testing.T) {
	c, f, o := fixture()
	c.EmitFrames = false
	o.Output = "test.ts"
	_, e := Run(context.Background(), c, o)
	if e == nil || f.closed != 0 {
		t.Fatal(e, f)
	}
}

func TestShutdownBeforeFirstFrameDoesNotStartEncoder(t *testing.T) {
	c, f, o := fixture()
	queue := make(chan Request, 1)
	queue <- Request{Command: Command{Method: "shutdown"}}
	o.Requests = queue
	o.Output = filepath.Join(t.TempDir(), "not-created.ts")
	o.FFmpeg = "this-encoder-must-not-start"
	r, err := Run(context.Background(), c, o)
	if err != nil || r.Frames != 0 || r.Encoded != nil || f.closed != 1 {
		t.Fatal(r, err, f)
	}
	if _, err := os.Stat(o.Output); !os.IsNotExist(err) {
		t.Fatal("unexpected output", err)
	}
}
