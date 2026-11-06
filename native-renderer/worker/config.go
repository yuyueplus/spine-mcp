package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type Config struct {
	Skeleton      string        `json:"skeleton"`
	Atlas         string        `json:"atlas"`
	Renderer      string        `json:"renderer"`
	GPUVendorID   uint16        `json:"gpuVendorId,omitempty"`
	GPUDeviceID   uint16        `json:"gpuDeviceId,omitempty"`
	Shaders       string        `json:"shaders,omitempty"`
	Width         int           `json:"width"`
	Height        int           `json:"height"`
	FPS           float64       `json:"fps"`
	Frames        int           `json:"frames"`
	Warmup        int           `json:"warmup"`
	Paced         bool          `json:"paced"`
	EmitFrames    bool          `json:"emitFrames"`
	MSAA          int           `json:"msaa"`
	Animation     string        `json:"animation,omitempty"`
	Playlist      []string      `json:"playlist,omitempty"`
	ClipFrames    int           `json:"clipFrames"`
	Loop          bool          `json:"loop"`
	Mix           float64       `json:"mix"`
	X             *float64      `json:"x,omitempty"`
	Y             *float64      `json:"y,omitempty"`
	Scale         *float64      `json:"scale,omitempty"`
	Background    *uint32       `json:"background,omitempty"`
	AllowSoftware bool          `json:"allowSoftware"`
	Encoder       EncoderConfig `json:"encoder,omitempty"`
	Audio         []AudioTrack  `json:"audio,omitempty"`
	QueueFrames   int           `json:"queueFrames,omitempty"`
	PixelFormat   string        `json:"pixelFormat,omitempty"`
	Verification  string        `json:"verification,omitempty"`
}

func DefaultConfig() Config {
	return Config{Width: 1280, Height: 720, FPS: 30, Frames: 450, Warmup: 10, Renderer: "auto", MSAA: 4, Paced: true, EmitFrames: true, ClipFrames: 90, Loop: true, Mix: .2}
}
func LoadConfig(filename string) (Config, error) {
	c := DefaultConfig()
	b, err := os.ReadFile(filename)
	if err != nil {
		return c, err
	}
	if len(b) > 1024*1024 {
		return c, errors.New("config exceeds 1 MiB")
	}
	if err = json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	base, err := filepath.Abs(filepath.Dir(filename))
	if err != nil {
		return c, err
	}
	fields := []*string{&c.Skeleton, &c.Atlas, &c.Shaders}
	for i := range c.Audio {
		fields = append(fields, &c.Audio[i].File)
	}
	for _, field := range fields {
		if *field != "" && !filepath.IsAbs(*field) {
			*field = filepath.Join(base, *field)
		}
	}
	return c, c.Validate()
}
func (c Config) Validate() error {
	if c.GPUDeviceID != 0 && c.GPUVendorID == 0 {
		return errors.New("gpuDeviceId requires gpuVendorId")
	}
	if c.Verification != "" && c.Verification != "full" && c.Verification != "packets" {
		return errors.New("verification must be full or packets")
	}
	if c.PixelFormat != "" && c.PixelFormat != "rgba" && c.PixelFormat != "nv12" {
		return errors.New("pixelFormat must be rgba or nv12")
	}
	if c.PixelFormat == "nv12" && (c.Width%4 != 0 || c.Height%2 != 0) {
		return errors.New("GPU NV12 requires width divisible by4 and even height")
	}
	if err := c.Encoder.Validate(); err != nil {
		return err
	}
	if len(c.Audio) > 8 || c.QueueFrames < 0 || c.QueueFrames > 8 {
		return errors.New("audio tracks or frame queue exceed limits")
	}
	for _, track := range c.Audio {
		if err := track.Validate(); err != nil {
			return err
		}
	}
	if c.Skeleton == "" || c.Atlas == "" {
		return errors.New("skeleton and atlas paths are required")
	}
	if c.Width < 64 || c.Width > 4096 || c.Height < 64 || c.Height > 4096 {
		return errors.New("width and height must be within 64..4096")
	}
	if math.IsNaN(c.FPS) || math.IsInf(c.FPS, 0) || c.FPS < 1 || c.FPS > 120 {
		return errors.New("fps must be within 1..120")
	}
	if c.Frames < 0 || c.Frames > 100000000 || c.Warmup < 0 || c.Warmup > 1000 {
		return errors.New("invalid frame limit or warmup")
	}
	if c.ClipFrames < 1 || c.ClipFrames > 1000000 {
		return errors.New("clipFrames must be within 1..1000000")
	}
	if c.MSAA != 1 && c.MSAA != 4 {
		return errors.New("msaa must be 1 or 4")
	}
	if c.Mix < 0 || c.Mix > 30 || math.IsNaN(c.Mix) || math.IsInf(c.Mix, 0) {
		return errors.New("mix must be within 0..30")
	}
	for _, field := range []struct {
		name     string
		p        *float64
		min, max float64
	}{{"x", c.X, -100000, 100000}, {"y", c.Y, -100000, 100000}, {"scale", c.Scale, .00001, 10000}} {
		if field.p != nil && (math.IsNaN(*field.p) || math.IsInf(*field.p, 0) || *field.p < field.min || *field.p > field.max) {
			return fmt.Errorf("invalid %s", field.name)
		}
	}
	switch c.Renderer {
	case "auto", "d3d12", "d3d11", "vulkan", "metal", "opengl":
	default:
		return errors.New("unsupported renderer")
	}
	if len(c.Playlist) > 1000 {
		return errors.New("playlist exceeds 1000 entries")
	}
	return nil
}
func (c Config) Format() string {
	if c.PixelFormat == "" {
		return "rgba"
	}
	return c.PixelFormat
}
func (c Config) FrameBytes() int {
	if c.Format() == "nv12" {
		return c.Width * c.Height * 3 / 2
	}
	return c.Width * c.Height * 4
}
func (c Config) Stride() int {
	if c.Format() == "nv12" {
		return c.Width
	}
	return c.Width * 4
}
func DefaultLibrary() string {
	name := "libspine-bgfx.so"
	if runtime.GOOS == "windows" {
		name = "spine-bgfx.dll"
	} else if runtime.GOOS == "darwin" {
		name = "libspine-bgfx.dylib"
	}
	exe, err := os.Executable()
	if err == nil {
		candidate := filepath.Join(filepath.Dir(exe), name)
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return filepath.Join("build", "bin", "Release", name)
}
func isNetwork(output string) bool { return strings.HasPrefix(strings.ToLower(output), "srt://") }
