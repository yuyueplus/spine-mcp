package worker

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestRealGPUConvertsNV12OnGPU(t *testing.T) {
	source, library := os.Getenv("SBGFX_TEST_ASSET_DIR"), os.Getenv("SBGFX_TEST_LIBRARY")
	session := os.Getenv("SBGFX_TEST_SESSION")
	if source == "" && session == "" || library == "" {
		t.Skip("real GPU assets/library not configured")
	}
	c := DefaultConfig()
	if session != "" {
		var err error
		c, err = LoadConfig(session)
		if err != nil {
			t.Fatal(err)
		}
	} else {
		c.Skeleton = filepath.Join(source, "skeleton.skel")
		c.Atlas = filepath.Join(source, "skeleton.atlas")
	}
	c.X = nil
	c.Y = nil
	c.Scale = nil
	c.PixelFormat = "rgba"
	c.Width = 320
	c.Height = 240
	c.Frames = 1
	c.Warmup = 2
	c.Paced = false
	c.Renderer = os.Getenv("SBGFX_TEST_RENDERER")
	if c.Renderer == "" {
		c.Renderer = "vulkan"
	}
	c.Animation = ""
	var rgba, nv12 []byte
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	o := Options{Library: library, OnFrame: func(_ int, p []byte, _ Info) error { rgba = append([]byte(nil), p...); return nil }}
	if _, err := Run(ctx, c, o); err != nil {
		t.Fatal(err)
	}
	c.PixelFormat = "nv12"
	o.OnFrame = func(_ int, p []byte, _ Info) error { nv12 = append([]byte(nil), p...); return nil }
	report, err := Run(ctx, c, o)
	if err != nil {
		t.Fatal(err)
	}
	if len(nv12) != c.Width*c.Height*3/2 || report.Info.PixelFormat != "nv12" {
		t.Fatal("wrong NV12 layout")
	}
	errorSum, maxError := 0.0, 0.0
	for y := 0; y < c.Height; y++ {
		for x := 0; x < c.Width; x++ {
			i := (y*c.Width + x) * 4
			expected := 16 + 219*(.2126*float64(rgba[i])+.7152*float64(rgba[i+1])+.0722*float64(rgba[i+2]))/255
			delta := math.Abs(float64(nv12[y*c.Width+x]) - expected)
			errorSum += delta
			maxError = math.Max(maxError, delta)
		}
	}
	mean := errorSum / float64(c.Width*c.Height)
	if mean > 1 || maxError > 3 {
		t.Fatalf("GPU luma mismatch: mean=%f max=%f", mean, maxError)
	}
	for y := 0; y < c.Height; y += 2 {
		for x := 0; x < c.Width; x += 2 {
			r, g, b := 0.0, 0.0, 0.0
			for dy := 0; dy < 2; dy++ {
				for dx := 0; dx < 2; dx++ {
					i := ((y+dy)*c.Width + x + dx) * 4
					r += float64(rgba[i]) / 1020
					g += float64(rgba[i+1]) / 1020
					b += float64(rgba[i+2]) / 1020
				}
			}
			l := .2126*r + .7152*g + .0722*b
			i := c.Width*c.Height + (y/2)*c.Width + x
			if math.Abs(float64(nv12[i])-(128+224*(b-l)/1.8556)) > 3 || math.Abs(float64(nv12[i+1])-(128+224*(r-l)/1.5748)) > 3 {
				t.Fatal("GPU chroma mismatch")
			}
		}
	}
}

func TestRealAudioMixAndQueuedEncoding(t *testing.T) {
	ffmpeg, ffprobe := os.Getenv("SBGFX_TEST_FFMPEG"), os.Getenv("SBGFX_TEST_FFPROBE")
	if ffmpeg == "" || ffprobe == "" {
		t.Skip("FFmpeg integration not configured")
	}
	c, _, o := fixture()
	c.Frames = 60
	c.FPS = 30
	c.QueueFrames = 2
	folder := t.TempDir()
	tone := filepath.Join(folder, "tone.wav")
	samples := 48000 / 2
	wav := make([]byte, 44+samples*2)
	copy(wav, "RIFF")
	binary.LittleEndian.PutUint32(wav[4:], uint32(len(wav)-8))
	copy(wav[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(wav[16:], 16)
	binary.LittleEndian.PutUint16(wav[20:], 1)
	binary.LittleEndian.PutUint16(wav[22:], 1)
	binary.LittleEndian.PutUint32(wav[24:], 48000)
	binary.LittleEndian.PutUint32(wav[28:], 96000)
	binary.LittleEndian.PutUint16(wav[32:], 2)
	binary.LittleEndian.PutUint16(wav[34:], 16)
	copy(wav[36:], "data")
	binary.LittleEndian.PutUint32(wav[40:], uint32(samples*2))
	for i := 0; i < samples; i++ {
		binary.LittleEndian.PutUint16(wav[44+i*2:], uint16(int16(math.Sin(float64(i)*2*math.Pi*440/48000)*4000)))
	}
	if err := os.WriteFile(tone, wav, 0600); err != nil {
		t.Fatal(err)
	}
	gain := .5
	c.Audio = []AudioTrack{{File: tone, Loop: true, Gain: &gain}, {File: tone, OffsetMS: 250, Gain: &gain}}
	o.Output = filepath.Join(folder, "mixed.mp4")
	o.FFmpeg = ffmpeg
	o.FFprobe = ffprobe
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, err := Run(ctx, c, o)
	if err != nil {
		t.Fatal(err)
	}
	if !r.Passed || r.Encoded == nil || !r.Encoded.AudioIncluded || r.Frames != 60 {
		t.Fatal("missing encoded audio/video")
	}
	decoded := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-i", o.Output, "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", "48000", "pipe:1")
	hideProcess(decoded)
	pcm, err := decoded.Output()
	if err != nil {
		t.Fatal(err)
	}
	rms := func(start, end float64) float64 {
		sum := 0.0
		n := 0
		for i := int(start * 48000); i < int(end*48000) && i*2+1 < len(pcm); i++ {
			v := float64(int16(binary.LittleEndian.Uint16(pcm[i*2:])))
			sum += v * v
			n++
		}
		if n == 0 {
			return 0
		}
		return math.Sqrt(sum / float64(n))
	}
	one, two, loop := rms(.05, .2), rms(.35, .6), rms(.9, 1.2)
	if one < 500 || two/one < 1.7 || two/one > 2.3 || math.Abs(loop/one-1) > .15 {
		t.Fatalf("audio gain/offset/loop mix mismatch: %f %f %f", one, two, loop)
	}
}

// An actual probe catches device-specific minimum frame dimensions that a
// fake FFmpeg executable cannot validate.
func TestRealHardwareEncoderProbe(t *testing.T) {
	codec, ffmpeg := os.Getenv("SBGFX_TEST_HARDWARE_ENCODER"), os.Getenv("SBGFX_TEST_FFMPEG")
	if codec == "" || ffmpeg == "" {
		t.Skip("real hardware encoder not configured")
	}
	encoder := EncoderConfig{Codec: codec, BitrateKbps: 6000}
	if !encoder.Hardware() {
		t.Fatal("a hardware encoder is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := ProbeEncoder(ctx, ffmpeg, encoder); err != nil {
		t.Fatal(err)
	}
}

// A static fine-texture fixture exposes a recurring I-frame quality collapse.
// The old AMF ultra-low-latency preset produced a >12/255 mean RGB jump on
// RX550; low latency stays below 2/255 with the same 3.5 Mbps rate and GOP.
func TestRealAMFStaticTextureDoesNotPulseAtKeyframe(t *testing.T) {
	ffmpeg := os.Getenv("SBGFX_TEST_FFMPEG")
	if ffmpeg == "" || os.Getenv("SBGFX_TEST_HARDWARE_ENCODER") != "h264_amf" {
		t.Skip("real AMF encoder not configured")
	}
	const width, height, count = 1280, 720, 121
	frame := make([]byte, width*height*4)
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			i := (y*width + x) * 4
			frame[i], frame[i+1], frame[i+2], frame[i+3] = 29, 36, 52, 255
			if x >= 480 && x < 800 && y >= 180 && y < 580 {
				u, v := float64(x-480), float64(y-180)
				frame[i] = 70 + byte(math.Sin(u*.23+v*.31)*32+32)
				frame[i+1] = 90 + byte(math.Sin(u*.17-v*.13)*48+48)
				frame[i+2] = 100 + byte(((x-480)*17+(y-180)*11)%100)
			}
		}
	}
	c := DefaultConfig()
	c.Width, c.Height, c.FPS, c.PixelFormat = width, height, 30, "rgba"
	c.Encoder = EncoderConfig{Codec: "h264_amf", BitrateKbps: 3500}
	output := filepath.Join(t.TempDir(), "static-texture.mp4")
	args, err := EncoderArgs(c, output, false)
	if err != nil {
		t.Fatal(err)
	}
	readers := make([]io.Reader, count)
	for i := range readers {
		readers[i] = bytes.NewReader(frame)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	encode := exec.CommandContext(ctx, ffmpeg, args...)
	hideProcess(encode)
	encode.Stdin = io.MultiReader(readers...)
	if log, err := encode.CombinedOutput(); err != nil {
		t.Fatalf("AMF encode: %v: %s", err, log)
	}
	decode := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-i", output,
		"-vf", "select=between(n\\,59\\,61),crop=320:400:480:180", "-fps_mode", "passthrough",
		"-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1")
	hideProcess(decode)
	pixels, err := decode.Output()
	if err != nil {
		t.Fatal(err)
	}
	const frameBytes = 320 * 400 * 3
	if len(pixels) != 3*frameBytes {
		t.Fatalf("expected 3 decoded frames, got %d bytes", len(pixels))
	}
	for n := 1; n < 3; n++ {
		sum := 0.0
		for i := 0; i < frameBytes; i++ {
			sum += math.Abs(float64(pixels[n*frameBytes+i]) - float64(pixels[(n-1)*frameBytes+i]))
		}
		mean := sum / frameBytes
		t.Logf("static texture RGB change at frame %d: %.4f/255", 59+n, mean)
		if mean > 3 {
			t.Fatalf("static texture pulses across keyframe: mean RGB change %.4f/255", mean)
		}
	}
}
