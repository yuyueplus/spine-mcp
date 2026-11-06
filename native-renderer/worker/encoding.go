package worker

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type EncoderConfig struct {
	Codec       string `json:"codec,omitempty"`
	BitrateKbps int    `json:"bitrateKbps,omitempty"`
	Device      int    `json:"device,omitempty"`
}

func (e EncoderConfig) Name() string {
	if e.Codec == "" {
		return "libx264"
	}
	return e.Codec
}
func (e EncoderConfig) Hardware() bool { return e.Name() != "libx264" }
func (e EncoderConfig) Validate() error {
	switch e.Name() {
	case "libx264", "h264_nvenc", "h264_amf":
	default:
		return errors.New("unsupported H264 encoder")
	}
	if e.Device < 0 || e.Device > 31 || e.BitrateKbps < 0 || e.BitrateKbps > 200000 {
		return errors.New("encoder device/bitrate out of range")
	}
	return nil
}
func (e EncoderConfig) Args() []string {
	a := []string{"-c:v", e.Name()}
	if !e.Hardware() {
		return append(a, "-preset", "veryfast", "-tune", "zerolatency", "-crf", "23", "-threads", "2")
	}
	rate := e.BitrateKbps
	if rate == 0 {
		rate = 6000
	}
	if e.Name() == "h264_nvenc" {
		a = append(a, "-gpu", strconv.Itoa(e.Device), "-preset", "p4", "-tune", "ull", "-rc", "cbr", "-rc-lookahead", "0")
	}
	if e.Name() == "h264_amf" {
		a = append(a, "-usage", "ultralowlatency", "-quality", "balanced", "-rc", "cbr")
	}
	return append(a, "-b:v", fmt.Sprint(rate)+"k", "-maxrate", fmt.Sprint(rate)+"k", "-bufsize", fmt.Sprint(rate*2)+"k")
}

// Probe performs a real one-frame encode; compiled-in encoder names alone are insufficient.
func ProbeEncoder(ctx context.Context, executable string, encoder EncoderConfig) error {
	if err := encoder.Validate(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if executable == "" {
		executable = "ffmpeg"
	}
	// Some NVENC devices reject 64x64 despite supporting normal stream sizes.
	// Use a conservative probe size so a working encoder is not rejected.
	a := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "color=size=256x256:rate=30", "-frames:v", "1", "-an"}
	a = append(a, encoder.Args()...)
	a = append(a, "-pix_fmt", "yuv420p", "-bf", "0", "-f", "null", "-")
	cmd := exec.CommandContext(ctx, executable, a...)
	hideProcess(cmd)
	var log boundedLog
	cmd.Stderr = &log
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("real %s encoder probe failed: %w: %s", encoder.Name(), err, log.String())
	}
	return nil
}

type AudioTrack struct {
	File     string   `json:"file"`
	Gain     *float64 `json:"gain,omitempty"`
	Loop     bool     `json:"loop,omitempty"`
	OffsetMS int      `json:"offsetMs,omitempty"`
}

func (a AudioTrack) Validate() error {
	if a.File == "" || strings.Contains(a.File, "://") || strings.HasPrefix(a.File, "pipe:") {
		return errors.New("audio requires an explicit local file")
	}
	if a.OffsetMS < 0 || a.OffsetMS > 3600000 || a.Gain != nil && (math.IsNaN(*a.Gain) || math.IsInf(*a.Gain, 0) || *a.Gain < 0 || *a.Gain > 4) {
		return errors.New("audio gain/offset out of range")
	}
	return nil
}
