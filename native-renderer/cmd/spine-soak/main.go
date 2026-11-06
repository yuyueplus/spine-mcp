package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/yuyueplus/spine-mcp/native-renderer/rooms"
	"github.com/yuyueplus/spine-mcp/native-renderer/worker"
	"image/png"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

func run() error {
	hubFile := flag.String("hub", "", "local trusted room manager JSON")
	session := flag.String("session", "", "worker session JSON with target resolution, encoder and audio")
	destination := flag.String("output", "", "NEW acceptance folder inside hub root")
	count := flag.Int("rooms", 1, "simultaneous independent rooms")
	seconds := flag.Int("seconds", 86400, "media seconds per room,1..86400")
	misses := flag.Float64("max-miss-ratio", .001, "maximum deadline-miss fraction")
	hardware := flag.Bool("require-hardware", true, "require actual hardware encoding")
	stopEOF := flag.Bool("stop-on-stdin-eof", false, "cooperatively stop owned rooms when the controller closes stdin")
	flag.Parse()
	rootContext, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	if *stopEOF {
		go func() { _, _ = io.Copy(io.Discard, os.Stdin); stopSignals() }()
	}
	if *hubFile == "" || *session == "" || *destination == "" || *count < 1 || *count > 64 || *seconds < 1 || *seconds > 86400 || *misses < 0 || *misses > 1 {
		return fmt.Errorf("invalid bounded acceptance arguments")
	}
	b, err := os.ReadFile(*hubFile)
	if err != nil {
		return err
	}
	var hc rooms.Config
	if err = json.Unmarshal(b, &hc); err != nil {
		return err
	}
	cfg, err := worker.LoadConfig(*session)
	if err != nil {
		return err
	}
	if *hardware && !cfg.Encoder.Hardware() {
		return fmt.Errorf("hardware acceptance requires an explicit hardware encoder")
	}
	capacity := 0
	for _, s := range hc.Slots {
		capacity += s.Capacity
	}
	if capacity < *count {
		return fmt.Errorf("configured concurrent capacity is smaller than requested rooms")
	}
	destinationAbs, err := filepath.Abs(*destination)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(hc.Root, destinationAbs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return fmt.Errorf("acceptance destination escapes root")
	}
	if err = os.Mkdir(destinationAbs, 0700); err != nil {
		return err
	}
	hc.Directory = filepath.Join(destinationAbs, "manager")
	m, err := rooms.New(hc)
	if err != nil {
		return err
	}
	cfg.Frames = int(float64(*seconds)*cfg.FPS + .5)
	cfg.Paced = true
	cfg.EmitFrames = true
	cfg.QueueFrames = 2
	cfg.Verification = "packets"
	var pins []rooms.Pin
	atlasBytes := int64(0)
	seen := map[string]bool{}
	pin := func(file string) error {
		file, e := filepath.Abs(file)
		if e != nil {
			return e
		}
		if seen[file] {
			return nil
		}
		seen[file] = true
		f, e := os.Open(file)
		if e != nil {
			return e
		}
		h := sha256.New()
		_, e = io.Copy(h, f)
		_ = f.Close()
		if e != nil {
			return e
		}
		pins = append(pins, rooms.Pin{Path: file, SHA256: hex.EncodeToString(h.Sum(nil))})
		return nil
	}
	if err = pin(cfg.Skeleton); err != nil {
		return err
	}
	if err = pin(cfg.Atlas); err != nil {
		return err
	}
	for _, a := range cfg.Audio {
		if err = pin(a.File); err != nil {
			return err
		}
	}
	err = filepath.WalkDir(filepath.Dir(cfg.Atlas), func(file string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if len(pins) > 1000 {
			return fmt.Errorf("too many assets")
		}
		if d.IsDir() || !strings.HasSuffix(strings.ToLower(file), ".png") {
			return nil
		}
		f, e := os.Open(file)
		if e != nil {
			return e
		}
		size, e := png.DecodeConfig(f)
		_ = f.Close()
		if e != nil {
			return e
		}
		atlasBytes += int64(size.Width) * int64(size.Height) * 4
		return pin(file)
	})
	if err != nil {
		return err
	}
	sessionCopy := filepath.Join(destinationAbs, "session.json")
	b, _ = json.MarshalIndent(cfg, "", "  ")
	if err = os.WriteFile(sessionCopy, b, 0600); err != nil {
		return err
	}
	if err = pin(sessionCopy); err != nil {
		return err
	}
	ids := []string{}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = m.Shutdown(ctx)
	}()
	for i := 0; i < *count; i++ {
		id := fmt.Sprintf("soak-%02d", i)
		lease := *seconds + 600

		_, err = m.Start(rooms.Start{ID: id, ConfigFile: sessionCopy, Output: filepath.Join(destinationAbs, id+".ts"), MemoryMB: int((atlasBytes+int64(cfg.Width*cfg.Height*4*10))/(1024*1024)) + 64, MaxRestarts: 0, LeaseSeconds: lease, Pins: pins})
		if err != nil {
			return err
		}
		ids = append(ids, id)
	}
	ctx, cancel := context.WithTimeout(rootContext, time.Duration(*seconds+660)*time.Second)
	defer cancel()
	started := time.Now()
	lastProgress := time.Time{}
	for {
		done := true
		for _, v := range m.List() {
			switch v.State {
			case "failed", "expired", "interrupted", "stopped", "cleanup_failed":
				return fmt.Errorf("room %s failed: %s", v.ID, v.LastError)
			case "completed":
			default:
				done = false
			}
			if time.Since(started) > 120*time.Second && v.State == "queued" {
				return fmt.Errorf("requested rooms did not run concurrently")
			}
		}
		if done {
			break
		}
		if time.Since(lastProgress) > 30*time.Second {
			progress := map[string]any{"event": "soak-progress", "elapsedSeconds": time.Since(started).Seconds(), "rooms": m.List(), "secondsPerRoom": *seconds}
			_ = json.NewEncoder(os.Stdout).Encode(progress)
			body, _ := json.Marshal(progress)
			tmp := filepath.Join(destinationAbs, ".progress.tmp")
			if os.WriteFile(tmp, body, 0600) == nil {
				_ = os.Rename(tmp, filepath.Join(destinationAbs, "progress.json"))
			}
			lastProgress = time.Now()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	reports := []worker.Report{}
	for _, v := range m.List() {
		b, e := os.ReadFile(v.Report)
		if e != nil {
			return e
		}
		var r worker.Report
		if e = json.Unmarshal(b, &r); e != nil {
			return e
		}
		if !r.Passed || r.Frames != cfg.Frames || r.Encoded == nil || *hardware && !r.Encoded.HardwareEncoder || float64(r.DeadlineMisses)/float64(r.Frames) > *misses || r.Timing["frame"].P95MS > 1000/cfg.FPS {
			return fmt.Errorf("room %s exceeded acceptance budget", v.ID)
		}
		reports = append(reports, r)
	}
	result := map[string]any{"version": "0.2.0", "passed": true, "platform": runtime.GOOS, "rooms": len(reports), "secondsPerRoom": *seconds, "maximumMissRatio": *misses, "verification": "full encoded packet count; decoded-frame and color smoke acceptance is separate", "reports": reports, "sourcePins": pins}
	b, _ = json.MarshalIndent(result, "", "  ")
	if err = os.WriteFile(filepath.Join(destinationAbs, "acceptance.json"), b, 0600); err != nil {
		return err
	}
	fmt.Println(string(b))
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
