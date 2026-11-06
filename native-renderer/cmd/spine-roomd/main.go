package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/yuyueplus/spine-mcp/native-renderer/rooms"
	"github.com/yuyueplus/spine-mcp/native-renderer/worker"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func run() error {
	file := flag.String("config", "", "trusted local room-server configuration")
	state := flag.String("state", "", "write private loopback discovery receipt")
	idle := flag.Int("idle-seconds", 600, "stop after this idle period")
	flag.Parse()
	if *file == "" || *state == "" || *idle < 10 || *idle > 86400 {
		return fmt.Errorf("config, state and bounded idle timeout required")
	}
	b, err := os.ReadFile(*file)
	if err != nil {
		return err
	}
	configHash := sha256.Sum256(b)
	var c rooms.Config
	if err = json.Unmarshal(b, &c); err != nil {
		return err
	}
	m, err := rooms.New(c)
	if err != nil {
		return err
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		return err
	}
	token := hex.EncodeToString(secret)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	discovery := map[string]any{"url": "http://" + listener.Addr().String(), "token": token, "pid": os.Getpid(), "version": "0.2.0"}
	b, _ = json.Marshal(discovery)
	if err = os.WriteFile(*state, b, 0600); err != nil {
		listener.Close()
		return err
	}
	mux := http.NewServeMux()
	send := func(w http.ResponseWriter, data any, err error) {
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(data)
	}
	decode := func(w http.ResponseWriter, r *http.Request, v any) error {
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*1024*1024))
		d.DisallowUnknownFields()
		if err := d.Decode(v); err != nil {
			return err
		}
		var extra any
		if d.Decode(&extra) != io.EOF {
			return fmt.Errorf("extra request content")
		}
		return nil
	}
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		send(w, map[string]any{"version": "0.2.0", "pid": os.Getpid(), "slots": c.Slots, "configSha256": hex.EncodeToString(configHash[:])}, nil)
	})
	mux.HandleFunc("GET /v1/rooms", func(w http.ResponseWriter, r *http.Request) { send(w, m.List(), nil) })
	mux.HandleFunc("GET /v1/rooms/{id}", func(w http.ResponseWriter, r *http.Request) { v, e := m.Get(r.PathValue("id")); send(w, v, e) })
	mux.HandleFunc("POST /v1/rooms", func(w http.ResponseWriter, r *http.Request) {
		var s rooms.Start
		if e := decode(w, r, &s); e != nil {
			send(w, nil, e)
			return
		}
		v, e := m.Start(s)
		send(w, v, e)
	})
	mux.HandleFunc("POST /v1/rooms/{id}/stop", func(w http.ResponseWriter, r *http.Request) { v, e := m.Stop(r.PathValue("id")); send(w, v, e) })
	mux.HandleFunc("POST /v1/rooms/{id}/control", func(w http.ResponseWriter, r *http.Request) {
		var command worker.Command
		if e := decode(w, r, &command); e != nil {
			send(w, nil, e)
			return
		}
		e := m.Control(r.PathValue("id"), command)
		send(w, map[string]any{"queued": e == nil, "nativeApplied": false}, e)
	})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mux.ServeHTTP(w, r)
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		last := time.Now()
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.Tick()
				busy := false
				for _, r := range m.List() {
					if r.State == "queued" || r.State == "starting" || r.State == "running" || r.State == "retrying" || r.State == "stopping" {
						busy = true
					}
				}
				if busy {
					last = time.Now()
				}
				if time.Since(last) > time.Duration(*idle)*time.Second {
					cancel()
					return
				}
			}
		}
	}()
	go func() {
		<-ctx.Done()
		stopping, done := context.WithTimeout(context.Background(), 30*time.Second)
		_ = m.Shutdown(stopping)
		done()
		shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = server.Shutdown(shutdown)
	}()
	fmt.Printf("{\"event\":\"ready\",\"pid\":%d,\"version\":\"0.2.0\"}\n", os.Getpid())
	err = server.Serve(listener)
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
