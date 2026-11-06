package broadcast

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/yuyueplus/spine-mcp/native-renderer/rooms"
)

//go:embed web/*
var web embed.FS

type Config struct {
	Root, Directory, Assets, Worker, Library, Shaders, FFmpeg, FFprobe string
	Codec                                                              string
}
type Job struct {
	ID          string     `json:"id"`
	Request     Request    `json:"request"`
	State       string     `json:"state"`
	Error       string     `json:"error,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	StartedAt   *time.Time `json:"startedAt,omitempty"`
	EndedAt     *time.Time `json:"endedAt,omitempty"`
	Frames      int        `json:"frames"`
	Fingerprint string     `json:"fingerprint"`
	Duration    float64    `json:"duration"`
	Numbers     []int      `json:"numbers"`
	Colors      []string   `json:"colors"`
	SettledAt   []float64  `json:"settledAt"`
	Playlist    string     `json:"playlist"`
	Replay      string     `json:"replay"`
	ReplayReady bool       `json:"replayReady"`
	Scene       string     `json:"scene"`
}
type Server struct {
	mu         sync.Mutex
	config     Config
	manager    *rooms.Manager
	jobs       map[string]*Job
	requests   map[string]string
	active     string
	key        string
	closing    bool
	background sync.WaitGroup
	runner     func(string)
}

func uuid() string {
	var b [16]byte
	_, err := rand.Read(b[:])
	if err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func fingerprint(r Request) string {
	data, _ := json.Marshal(r)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
func terminal(state string) bool {
	return state == "completed" || state == "failed" || state == "cancelled" || state == "interrupted"
}
func fileHash(file string) (string, error) {
	f, e := os.Open(file)
	if e != nil {
		return "", e
	}
	defer f.Close()
	h := sha256.New()
	_, e = io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), e
}

func verifyAssets(directory string) error {
	data, e := os.ReadFile(filepath.Join(directory, "manifest.json"))
	if e != nil {
		return e
	}
	var m struct {
		Schema string            `json:"schema"`
		Files  map[string]string `json:"files"`
	}
	if e = json.Unmarshal(data, &m); e != nil {
		return e
	}
	if m.Schema != "lottery-demo-assets/1" || len(m.Files) == 0 {
		return errors.New("invalid asset manifest")
	}
	for name, expected := range m.Files {
		if filepath.IsAbs(name) || strings.Contains(name, "..") || strings.Contains(name, "\\") {
			return errors.New("unsafe asset manifest path")
		}
		actual, e := fileHash(filepath.Join(directory, filepath.FromSlash(name)))
		if e != nil {
			return e
		}
		if actual != expected {
			return fmt.Errorf("asset hash mismatch: %s", name)
		}
	}
	for n := 1; n <= 49; n++ {
		for _, kind := range []string{"normal", "special"} {
			if _, e := os.Stat(filepath.Join(directory, "audio", fmt.Sprintf("%s-%02d.wav", kind, n))); e != nil {
				return e
			}
		}
	}
	return nil
}

func New(c Config) (*Server, error) {
	if !filepath.IsAbs(c.Root) || !filepath.IsAbs(c.Directory) || !filepath.IsAbs(c.Assets) {
		return nil, errors.New("absolute local paths required")
	}
	if c.Codec == "" {
		c.Codec = "libx264"
	}
	if c.Codec != "libx264" && c.Codec != "h264_amf" && c.Codec != "h264_nvenc" {
		return nil, errors.New("unsupported demo encoder")
	}
	if e := verifyAssets(c.Assets); e != nil {
		return nil, e
	}
	if e := os.MkdirAll(filepath.Join(c.Directory, "jobs"), 0700); e != nil {
		return nil, e
	}
	m, e := rooms.New(rooms.Config{Root: c.Root, Directory: filepath.Join(c.Directory, "rooms"), Worker: c.Worker, Library: c.Library, FFmpeg: c.FFmpeg, FFprobe: c.FFprobe, Slots: []rooms.Slot{{ID: "demo", Capacity: 1, MemoryMB: 1024}}, QueueLimit: 1})
	if e != nil {
		return nil, e
	}
	s := &Server{config: c, manager: m, jobs: map[string]*Job{}, requests: map[string]string{}, key: uuid() + uuid()}
	s.runner = s.run
	entries, e := os.ReadDir(filepath.Join(c.Directory, "jobs"))
	if e != nil {
		return nil, e
	}
	for _, entry := range entries {
		if !entry.IsDir() || !namePattern.MatchString(entry.Name()) {
			continue
		}
		data, e := os.ReadFile(filepath.Join(c.Directory, "jobs", entry.Name(), "job.json"))
		if e != nil {
			continue
		}
		var j Job
		if json.Unmarshal(data, &j) != nil || j.ID != entry.Name() {
			continue
		}
		if !terminal(j.State) {
			j.State = "interrupted"
			j.Error = "演示服务已重启；本任务不会自动重复播放"
			now := time.Now()
			j.EndedAt = &now
		}
		s.jobs[j.ID] = &j
		s.requests[j.Request.RequestID] = j.ID
		if len(s.jobs) > 16 {
			return nil, errors.New("demo history limit reached; use a new state directory")
		}
	}
	return s, nil
}

func (s *Server) persistLocked(j *Job) {
	data, e := json.MarshalIndent(j, "", "  ")
	if e != nil {
		return
	}
	dir := filepath.Join(s.config.Directory, "jobs", j.ID)
	if os.MkdirAll(dir, 0700) != nil {
		return
	}
	f, e := os.CreateTemp(dir, "job-*.tmp")
	if e != nil {
		return
	}
	temp := f.Name()
	defer os.Remove(temp)
	if _, e = f.Write(data); e != nil {
		f.Close()
		return
	}
	if f.Close() != nil {
		return
	}
	_ = os.Rename(temp, filepath.Join(dir, "job.json"))
}
func clone(j *Job) Job {
	c := *j
	c.Numbers = append([]int(nil), j.Numbers...)
	c.Colors = append([]string(nil), j.Colors...)
	c.SettledAt = append([]float64(nil), j.SettledAt...)
	c.Request.RegularNumbers = append([]int(nil), j.Request.RegularNumbers...)
	return c
}
func (s *Server) update(id, state, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	j := s.jobs[id]
	if j == nil {
		return
	}
	if j.State == "stopping" && terminal(state) {
		state, message = "cancelled", ""
	}
	j.State = state
	if message != "" {
		j.Error = message
	}
	if terminal(state) {
		now := time.Now()
		j.EndedAt = &now
	}
	s.persistLocked(j)
}

// Release the slot only after the renderer and receiver have both drained.
func (s *Server) finish(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	j := s.jobs[id]
	if j.State == "stopping" || (s.closing && !terminal(j.State)) {
		j.State = "cancelled"
	}
	if !terminal(j.State) {
		j.State, j.Error = "failed", "演示任务意外结束"
	}
	if j.EndedAt == nil {
		now := time.Now()
		j.EndedAt = &now
	}
	if s.active == id {
		s.active = ""
	}
	s.persistLocked(j)
}

func (s *Server) Submit(r Request) (Job, bool, error) {
	r.RegularNumbers = append([]int(nil), r.RegularNumbers...)
	if e := r.Validate(); e != nil {
		return Job{}, false, e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return Job{}, false, errors.New("service is stopping")
	}
	hash := fingerprint(r)
	if id := s.requests[r.RequestID]; id != "" {
		j := s.jobs[id]
		if j.Fingerprint != hash {
			return Job{}, false, errors.New("REQUEST_CONFLICT")
		}
		return clone(j), true, nil
	}
	for _, j := range s.jobs {
		if j.Request.RoundID == r.RoundID {
			return Job{}, false, errors.New("ROUND_EXISTS")
		}
	}
	if s.active != "" {
		return Job{}, false, errors.New("ROUND_LOCKED")
	}
	if len(s.jobs) >= 16 {
		return Job{}, false, errors.New("HISTORY_LIMIT")
	}
	id := uuid()
	j := &Job{ID: id, Request: r, State: "preparing", CreatedAt: time.Now(), Fingerprint: hash, Duration: Duration, Numbers: r.Numbers(), SettledAt: revealTimes(), Playlist: "/media/" + id + "/live.m3u8", Replay: "/media/" + id + "/replay.mp4", Scene: "/scene/" + id + "/scene.json"}
	for _, n := range j.Numbers {
		j.Colors = append(j.Colors, Color(n))
	}
	s.jobs[id] = j
	s.requests[r.RequestID] = id
	s.active = id
	s.persistLocked(j)
	s.background.Add(1)
	go func() { defer s.background.Done(); defer s.finish(id); s.runner(id) }()
	return clone(j), false, nil
}

func (s *Server) run(id string) {
	s.mu.Lock()
	request := s.jobs[id].Request
	s.mu.Unlock()
	dir := filepath.Join(s.config.Directory, "jobs", id)
	c, e := Build(dir, s.config.Assets, s.config.Shaders, request, true)
	if e != nil {
		s.update(id, "failed", e.Error())
		return
	}
	c.Encoder.Codec = s.config.Codec
	c.Encoder.BitrateKbps = 3500
	data, _ := json.MarshalIndent(c, "", "  ")
	if e = os.WriteFile(filepath.Join(dir, "session.json"), data, 0600); e != nil {
		s.update(id, "failed", e.Error())
		return
	}
	s.mu.Lock()
	cancelled := s.jobs[id].State == "stopping" || s.closing
	s.mu.Unlock()
	if cancelled {
		return
	}
	udp, e := net.ListenPacket("udp", "127.0.0.1:0")
	if e != nil {
		s.update(id, "failed", e.Error())
		return
	}
	port := udp.LocalAddr().(*net.UDPAddr).Port
	udp.Close()
	log, e := os.OpenFile(filepath.Join(dir, "relay.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if e != nil {
		s.update(id, "failed", e.Error())
		return
	}
	defer log.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	args := []string{"-hide_banner", "-loglevel", "warning", "-nostdin", "-n", "-i", fmt.Sprintf("srt://127.0.0.1:%d?mode=listener&latency=100000&listen_timeout=60000000", port), "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-f", "hls", "-hls_time", "2", "-hls_list_size", "0", "-hls_flags", "independent_segments+temp_file", "-hls_segment_filename", filepath.Join(dir, "segment-%05d.ts"), filepath.Join(dir, "live.m3u8"), "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", filepath.Join(dir, "replay.mp4")}
	relay := exec.CommandContext(ctx, s.config.FFmpeg, args...)
	hideProcess(relay)
	relay.Stdout = io.Discard
	relay.Stderr = log
	if e = relay.Start(); e != nil {
		s.update(id, "failed", e.Error())
		return
	}
	done := make(chan error, 1)
	go func() { done <- relay.Wait() }()
	var pins []rooms.Pin
	files := []string{c.Skeleton, c.Atlas, filepath.Join(dir, "session.json"), filepath.Join(dir, "physics.json"), filepath.Join(s.config.Assets, "manifest.json")}
	entries, _ := os.ReadDir(s.config.Assets)
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".png") {
			files = append(files, filepath.Join(s.config.Assets, entry.Name()))
		}
	}
	for _, a := range c.Audio {
		files = append(files, a.File)
	}
	for _, file := range files {
		sum, err := fileHash(file)
		if err != nil {
			s.update(id, "failed", err.Error())
			return
		}
		pins = append(pins, rooms.Pin{Path: file, SHA256: sum})
	}
	s.mu.Lock()
	cancelled = s.jobs[id].State == "stopping" || s.closing
	s.mu.Unlock()
	if cancelled {
		return
	}
	_, e = s.manager.Start(rooms.Start{ID: id, ConfigFile: filepath.Join(dir, "session.json"), Output: fmt.Sprintf("srt://127.0.0.1:%d?mode=caller&latency=100000&connect_timeout=5000", port), MemoryMB: 256, GPU: "demo", LeaseSeconds: 240, MaxRestarts: 0, Pins: pins})
	if e != nil {
		s.update(id, "failed", e.Error())
		return
	}
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	state := ""
	message := ""
	receiverExited := false
	var relayError error
	var receiverExitedAt time.Time
	for state == "" {
		select {
		case relayError = <-done:
			receiverExited = true
			receiverExitedAt = time.Now()
			if relayError != nil {
				_, _ = s.manager.Stop(id)
				state = "failed"
				message = "接收器提前结束，请查看本任务日志"
			}
		case <-ticker.C:
			s.manager.Tick()
			v, err := s.manager.Get(id)
			if err != nil {
				state = "failed"
				message = err.Error()
				break
			}
			s.mu.Lock()
			j := s.jobs[id]
			stopping := j.State == "stopping" || s.closing
			j.Frames = v.Frames
			if v.State == "running" && !stopping {
				j.State = "playing"
				if j.StartedAt == nil {
					now := time.Now()
					j.StartedAt = &now
					s.persistLocked(j)
				}
			}
			s.mu.Unlock()
			if stopping {
				_, _ = s.manager.Stop(id)
			}
			switch v.State {
			case "completed":
				state = "completed"
			case "stopped":
				state = "cancelled"
			case "failed", "expired", "cleanup_failed":
				state = "failed"
				message = v.LastError
			}
			if state == "" && receiverExited && time.Since(receiverExitedAt) > 8*time.Second {
				_, _ = s.manager.Stop(id)
				state = "failed"
				message = "接收器已结束但渲染任务没有正常完成"
			}
		}
	}
	if !receiverExited {
		select {
		case relayError = <-done:
		case <-time.After(12 * time.Second):
			cancel()
			relayError = <-done
			if state == "completed" {
				state = "failed"
				message = "视频接收器没有正常结束"
			}
		}
	}
	if state == "stopped" || state == "stopping" {
		state = "cancelled"
	}
	if state == "completed" && relayError != nil {
		state = "failed"
		message = "视频接收器报错，请查看relay.log"
	}
	if state == "completed" {
		probe := exec.Command(s.config.FFprobe, "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames,width,height", "-of", "json", filepath.Join(dir, "replay.mp4"))
		hideProcess(probe)
		body, err := probe.Output()
		var p struct {
			Streams []struct {
				Count  string `json:"nb_read_frames"`
				Width  int    `json:"width"`
				Height int    `json:"height"`
			} `json:"streams"`
		}
		if err == nil {
			err = json.Unmarshal(body, &p)
		}
		if err != nil || len(p.Streams) != 1 || p.Streams[0].Count != "3510" || p.Streams[0].Width != 1280 || p.Streams[0].Height != 720 {
			state = "failed"
			message = "回放完整解码帧数或尺寸核对失败"
		} else {
			s.mu.Lock()
			s.jobs[id].ReplayReady = true
			s.jobs[id].Frames = 3510
			s.mu.Unlock()
		}
	}
	s.update(id, state, message)
}

func (s *Server) Stop(id string) (Job, error) {
	s.mu.Lock()
	j := s.jobs[id]
	if j == nil {
		s.mu.Unlock()
		return Job{}, errors.New("not found")
	}
	if terminal(j.State) {
		out := clone(j)
		s.mu.Unlock()
		return out, nil
	}
	j.State = "stopping"
	s.persistLocked(j)
	out := clone(j)
	s.mu.Unlock()
	if s.manager != nil {
		_, _ = s.manager.Stop(id)
	}
	return out, nil
}
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	s.closing = true
	s.mu.Unlock()
	var e error
	if s.manager != nil {
		e = s.manager.Shutdown(ctx)
	}
	done := make(chan struct{})
	go func() { s.background.Wait(); close(done) }()
	select {
	case <-done:
		return e
	case <-ctx.Done():
		return ctx.Err()
	}
}

func jsonResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil || host != "127.0.0.1" {
			http.Error(w, "loopback host required", http.StatusForbidden)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		if r.Method != "GET" && r.Method != "HEAD" {
			if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Demo-Key")), []byte(s.key)) != 1 {
				jsonResponse(w, 403, map[string]string{"error": "invalid local control key"})
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host {
				jsonResponse(w, 403, map[string]string{"error": "unexpected origin"})
				return
			}
		}
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/config":
			jsonResponse(w, 200, map[string]any{"mode": "scripted_demo", "duration": Duration, "settledAt": revealTimes(), "colors": colorSets, "version": "prototype-6", "physics": fmt.Sprintf("official Box2D3.1.1,%dHz x%d substeps; one wide-camera coordinate world", physicsStepHz, physicsSubsteps), "views": []any{magnifierFor(0).description(), magnifierFor(6).description()}, "transport": "central inlet -> vertical riser -> top outlet -> left regular track / right special tray; guided constrained airflow before Box2D handoff", "scope": "Spine2.5D,12 number decals, baked3D resting pile, central airlift, one Box2D result world and uniformly magnified views of shared render state. Main chamber mixing remains authored. No fluid simulation, betting integration or presenter footage."})
		case r.Method == "GET" && r.URL.Path == "/api/rounds":
			s.mu.Lock()
			list := []Job{}
			for _, j := range s.jobs {
				list = append(list, clone(j))
			}
			s.mu.Unlock()
			sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt.After(list[j].CreatedAt) })
			jsonResponse(w, 200, list)
		case r.Method == "POST" && r.URL.Path == "/api/rounds":
			r.Body = http.MaxBytesReader(w, r.Body, 16384)
			decoder := json.NewDecoder(r.Body)
			decoder.DisallowUnknownFields()
			var request Request
			if e := decoder.Decode(&request); e != nil {
				jsonResponse(w, 400, map[string]string{"error": e.Error()})
				return
			}
			if decoder.Decode(&struct{}{}) != io.EOF {
				jsonResponse(w, 400, map[string]string{"error": "one JSON request required"})
				return
			}
			if e := request.Validate(); e != nil {
				jsonResponse(w, 400, map[string]string{"error": e.Error()})
				return
			}
			j, replay, e := s.Submit(request)
			if e != nil {
				jsonResponse(w, 409, map[string]string{"error": e.Error()})
				return
			}
			status := 202
			if replay {
				status = 200
			}
			jsonResponse(w, status, j)
		case strings.HasPrefix(r.URL.Path, "/api/rounds/"):
			parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/rounds/"), "/")
			id := parts[0]
			if !namePattern.MatchString(id) {
				http.NotFound(w, r)
				return
			}
			if len(parts) == 2 && parts[1] == "stop" && r.Method == "POST" {
				j, e := s.Stop(id)
				if e != nil {
					http.NotFound(w, r)
					return
				}
				jsonResponse(w, 200, j)
				return
			}
			if len(parts) != 1 || r.Method != "GET" {
				http.NotFound(w, r)
				return
			}
			s.mu.Lock()
			j := s.jobs[id]
			if j == nil {
				s.mu.Unlock()
				http.NotFound(w, r)
				return
			}
			out := clone(j)
			s.mu.Unlock()
			jsonResponse(w, 200, out)
		case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/media/"):
			parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/media/"), "/")
			if len(parts) != 2 || !namePattern.MatchString(parts[0]) {
				http.NotFound(w, r)
				return
			}
			s.mu.Lock()
			job := s.jobs[parts[0]]
			ready := job != nil && job.ReplayReady
			s.mu.Unlock()
			if job == nil {
				http.NotFound(w, r)
				return
			}
			file := parts[1]
			if file == "replay.mp4" {
				if !ready {
					http.NotFound(w, r)
					return
				}
				http.ServeFile(w, r, filepath.Join(s.config.Directory, "jobs", parts[0], file))
				return
			}
			if file != "live.m3u8" && !(strings.HasPrefix(file, "segment-") && strings.HasSuffix(file, ".ts") && len(file) == 16) {
				http.NotFound(w, r)
				return
			}
			data, e := os.ReadFile(filepath.Join(s.config.Directory, "jobs", parts[0], file))
			if e != nil {
				http.NotFound(w, r)
				return
			}
			if file == "live.m3u8" {
				w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			} else {
				w.Header().Set("Content-Type", "video/mp2t")
			}
			w.Header().Set("Content-Length", fmt.Sprint(len(data)))
			_, _ = w.Write(data)
		case r.Method == "GET" && (r.URL.Path == "/hls.min.js" || r.URL.Path == "/background.png"):
			name := strings.TrimPrefix(r.URL.Path, "/")
			http.ServeFile(w, r, filepath.Join(s.config.Assets, name))
		case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/scene/"):
			parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/scene/"), "/")
			if len(parts) != 2 || !namePattern.MatchString(parts[0]) || parts[1] != "scene.json" {
				http.NotFound(w, r)
				return
			}
			s.mu.Lock()
			exists := s.jobs[parts[0]] != nil
			s.mu.Unlock()
			if !exists {
				http.NotFound(w, r)
				return
			}
			http.ServeFile(w, r, filepath.Join(s.config.Directory, "jobs", parts[0], "scene.json"))
		case r.Method == "GET" && (r.URL.Path == "/" || r.URL.Path == "/index.html"):
			body, _ := web.ReadFile("web/index.html")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(strings.ReplaceAll(string(body), "__CONTROL_KEY__", s.key)))
		case r.Method == "GET" && (r.URL.Path == "/app.js" || r.URL.Path == "/style.css"):
			root, _ := fs.Sub(web, "web")
			http.FileServer(http.FS(root)).ServeHTTP(w, r)
		default:
			http.NotFound(w, r)
		}
	})
}
