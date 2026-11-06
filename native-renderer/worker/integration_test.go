package worker

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRealWorkerControls(t *testing.T) {
	source, library := os.Getenv("SBGFX_TEST_ASSET_DIR"), os.Getenv("SBGFX_TEST_LIBRARY")
	if source == "" || library == "" {
		t.Skip("set SBGFX_TEST_ASSET_DIR and SBGFX_TEST_LIBRARY for character integration")
	}
	c := DefaultConfig()
	c.Skeleton = filepath.Join(source, "skeleton.skel")
	c.Atlas = filepath.Join(source, "skeleton.atlas")
	c.Frames = 15
	c.Animation = "01_idle_breeze"
	requests := make(chan Request, 32)
	var responses []Response
	captured := map[int][32]byte{}
	send := func(method string, params map[string]any) {
		id, _ := json.Marshal(method)
		requests <- Request{Command: Command{ID: id, Method: method, Params: params}}
	}
	o := Options{Library: library, Requests: requests, OnEvent: func(e Event) error {
		if e.Response != nil {
			responses = append(responses, *e.Response)
		}
		return nil
	}, OnFrame: func(index int, p []byte, _ Info) error {
		captured[index] = sha256.Sum256(p)
		switch index {
		case 0:
			send("pause", nil)
		case 2:
			send("transform", map[string]any{"x": 800.0, "scale": .9})
		case 4:
			send("play", map[string]any{"animation": "missing"})
		case 5:
			send("skin", map[string]any{"name": "default"})
		case 6:
			send("play", map[string]any{"animation": "02_greeting_wave", "mix": 0.0})
		case 7:
			send("seek", map[string]any{"time": 1.0})
		case 8:
			send("speed", map[string]any{"value": .5})
		case 9:
			send("resume", nil)
		}
		return nil
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, e := Run(ctx, c, o)
	if e != nil || r.Frames != 15 {
		t.Fatal(r, e)
	}
	if captured[1] != captured[2] {
		t.Fatal("paused character changed")
	}
	if captured[2] == captured[3] {
		t.Fatal("transform did not change pixels")
	}
	if captured[10] == captured[14] {
		t.Fatal("resumed animation did not change pixels")
	}
	if len(responses) != 8 {
		t.Fatalf("responses: %+v", responses)
	}
	for _, response := range responses {
		if string(response.ID) == `"play"` && response.Error != "" {
			continue
		}
		if response.Error != "" {
			t.Fatal(response)
		}
	}
	if responses[0].AppliedAtFrame != 1 || responses[1].AppliedAtFrame != 3 || responses[2].Error == "" {
		t.Fatal(responses)
	}
}
