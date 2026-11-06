package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/yuyueplus/spine-mcp/native-renderer/broadcast"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

func main() {
	rootFlag := flag.String("root", "..", "workspace root")
	assetsFlag := flag.String("assets", "../work/lottery-demo-v2/assets-final", "sealed demo assets")
	directoryFlag := flag.String("state", "../work/lottery-demo-v6/run", "new owned state directory")
	binaryFlag := flag.String("binary", "build/bin/Release", "installed native worker directory")
	listen := flag.String("listen", "127.0.0.1:8090", "loopback HTTP bind")
	ffmpeg := flag.String("ffmpeg", "ffmpeg", "FFmpeg executable")
	ffprobe := flag.String("ffprobe", "ffprobe", "FFprobe executable")
	codec := flag.String("codec", "libx264", "explicit encoder")
	ttl := flag.Duration("ttl", 2*time.Hour, "bounded server lifetime")
	prepare := flag.String("prepare", "", "write a NEW original-result scene/config and exit")
	flag.Parse()
	fail := func(e error) {
		if e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(1)
		}
	}
	abs := func(s string) string { p, e := filepath.Abs(s); fail(e); return p }
	root, assets, dir, binary := abs(*rootFlag), abs(*assetsFlag), abs(*directoryFlag), abs(*binaryFlag)
	if *prepare != "" {
		_, e := broadcast.Build(abs(*prepare), assets, filepath.Join(binary, "shaders"), broadcast.Request{Mode: "scripted_demo", RoundID: "reference-001", RequestID: "reference-prepare", RegularNumbers: []int{40, 48, 10, 20, 27, 11}, SpecialNumber: 4}, false)
		fail(e)
		fmt.Println(abs(*prepare))
		return
	}
	host, _, e := net.SplitHostPort(*listen)
	fail(e)
	if host != "127.0.0.1" || *ttl < time.Minute || *ttl > 24*time.Hour {
		fail(fmt.Errorf("loopback bind and1min..24h lifetime required"))
	}
	worker, library := "spine-worker", "libspine-bgfx.so"
	if runtime.GOOS == "windows" {
		worker += ".exe"
		library = "spine-bgfx.dll"
	} else if runtime.GOOS == "darwin" {
		library = "libspine-bgfx.dylib"
	}
	s, e := broadcast.New(broadcast.Config{Root: root, Directory: dir, Assets: assets, Worker: filepath.Join(binary, worker), Library: filepath.Join(binary, library), Shaders: filepath.Join(binary, "shaders"), FFmpeg: *ffmpeg, FFprobe: *ffprobe, Codec: *codec})
	fail(e)
	listener, e := net.Listen("tcp", *listen)
	fail(e)
	server := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, *ttl)
	defer cancel()
	go func() {
		<-ctx.Done()
		shutdown, c := context.WithTimeout(context.Background(), 20*time.Second)
		defer c()
		_ = s.Shutdown(shutdown)
		_ = server.Shutdown(shutdown)
	}()
	url := "http://" + listener.Addr().String() + "/"
	receipt := map[string]any{"url": url, "pid": os.Getpid(), "mode": "scripted_demo", "expiresAt": time.Now().Add(*ttl), "stateDirectory": dir}
	body, _ := json.MarshalIndent(receipt, "", "  ")
	fail(os.WriteFile(filepath.Join(dir, "server.json"), body, 0600))
	fmt.Println(string(body))
	e = server.Serve(listener)
	if e != http.ErrServerClosed {
		fail(e)
	}
}
