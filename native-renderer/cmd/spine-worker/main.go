package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/yuyueplus/spine-mcp/native-renderer/worker"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
)

func run() int {
	configFile := flag.String("config", "", "session JSON file")
	library := flag.String("native", "", "native library path (default: beside worker)")
	output := flag.String("output", "", "local .ts/.mp4 file or explicit srt://host:port URL")
	reportFile := flag.String("report", "", "write verification report JSON")
	overwrite := flag.Bool("overwrite", false, "explicitly allow replacing the output file")
	controls := flag.Bool("control-stdin", false, "read newline-delimited JSON control requests from a pipe")
	stopOnEOF := flag.Bool("stop-on-control-eof", false, "stop an owned finite session when its control pipe closes")
	ffmpeg := flag.String("ffmpeg", "ffmpeg", "FFmpeg executable")
	ffprobe := flag.String("ffprobe", "ffprobe", "ffprobe executable")
	flag.Parse()
	if *configFile == "" {
		flag.Usage()
		return 2
	}
	c, err := worker.LoadConfig(*configFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if c.Frames == 0 && *output == "" {
		fmt.Fprintln(os.Stderr, "unlimited sessions require an output destination")
		return 1
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	encoder := json.NewEncoder(os.Stdout)
	var outputLock sync.Mutex
	emit := func(event worker.Event) error {
		outputLock.Lock()
		defer outputLock.Unlock()
		return encoder.Encode(event)
	}
	requests := make(chan worker.Request, 64)
	if *controls {
		go func() {
			defer close(requests)
			stopQueued := false
			scanner := bufio.NewScanner(os.Stdin)
			scanner.Buffer(make([]byte, 4096), 1024*1024)
			for scanner.Scan() {
				var command worker.Command
				if err := json.Unmarshal(scanner.Bytes(), &command); err != nil {
					_ = emit(worker.Event{Event: "control-error", Message: "Invalid control JSON"})
					continue
				}
				select {
				case requests <- worker.Request{Command: command}:
					if command.Method == "shutdown" {
						stopQueued = true
					}
				case <-ctx.Done():
					return
				}
			}
			if scanner.Err() != nil {
				_ = emit(worker.Event{Event: "control-error", Message: "Control input exceeds size limit or could not be read"})
			}
			if (c.Frames == 0 || *stopOnEOF) && !stopQueued {
				select {
				case requests <- worker.Request{Command: worker.Command{Method: "shutdown"}}:
				case <-ctx.Done():
				}
			}
		}()
	}
	opts := worker.Options{Library: *library, Output: *output, Overwrite: *overwrite, FFmpeg: *ffmpeg, FFprobe: *ffprobe, OnEvent: emit}
	if *controls {
		opts.Requests = requests
	}
	report, err := worker.Run(ctx, c, opts)
	if *reportFile != "" {
		if mkdirErr := os.MkdirAll(filepath.Dir(*reportFile), 0755); mkdirErr == nil {
			data, marshalErr := json.MarshalIndent(report, "", "  ")
			if marshalErr == nil {
				data = append(data, '\n')
				if writeErr := os.WriteFile(*reportFile, data, 0644); writeErr != nil && err == nil {
					err = writeErr
				}
			} else if err == nil {
				err = marshalErr
			}
		} else if err == nil {
			err = mkdirErr
		}
	}
	if err != nil {
		_ = emit(worker.Event{Event: "error", Message: err.Error()})
		return 1
	}
	return 0
}
func main() { os.Exit(run()) }
