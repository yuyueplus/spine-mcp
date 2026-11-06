package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os/exec"
	"strconv"
)

type AudioProbe struct {
	Codec          string  `json:"codec_name"`
	SampleRate     string  `json:"sample_rate"`
	Channels       int     `json:"channels"`
	Start          string  `json:"start_time"`
	Duration       string  `json:"duration"`
	VideoStart     string  `json:"videoStart"`
	AVStartErrorMS float64 `json:"avStartErrorMs"`
}

func verifyAudio(ctx context.Context, tool, file string, c Config, frames int) (*AudioProbe, error) {
	if tool == "" {
		tool = "ffprobe"
	}
	cmd := exec.CommandContext(ctx, tool, "-v", "error", "-show_entries", "stream=codec_type,codec_name,sample_rate,channels,start_time,duration", "-of", "json", file)
	hideProcess(cmd)
	b, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var p struct {
		Streams []struct {
			AudioProbe
			Type string `json:"codec_type"`
		} `json:"streams"`
	}
	if err = json.Unmarshal(b, &p); err != nil {
		return nil, err
	}
	var a *AudioProbe
	videoStart := 0.0
	for _, s := range p.Streams {
		if s.Type == "video" {
			videoStart, _ = strconv.ParseFloat(s.Start, 64)
		}
		if s.Type == "audio" {
			if a != nil {
				return nil, fmt.Errorf("expected one mixed audio stream")
			}
			x := s.AudioProbe
			a = &x
		}
	}
	if a == nil || a.Codec != "aac" || a.SampleRate != "48000" || a.Channels != 2 {
		return nil, fmt.Errorf("encoded audio format mismatch")
	}
	start, e := strconv.ParseFloat(a.Start, 64)
	if e != nil {
		return nil, e
	}
	a.VideoStart = strconv.FormatFloat(videoStart, 'f', 6, 64)
	a.AVStartErrorMS = math.Abs(start-videoStart) * 1000
	if a.AVStartErrorMS > 50 {
		return nil, fmt.Errorf("audio/video start differs by %fms", a.AVStartErrorMS)
	}
	if duration, e := strconv.ParseFloat(a.Duration, 64); e == nil && math.Abs(duration-float64(frames)/c.FPS) > .15 {
		return nil, fmt.Errorf("audio duration differs from encoded video")
	}
	return a, nil
}
