package rooms

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/yuyueplus/spine-mcp/native-renderer/worker"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Slot struct {
	ID          string `json:"id"`
	Capacity    int    `json:"capacity"`
	MemoryMB    int    `json:"memoryMB"`
	DockerGPU   string `json:"dockerGpu,omitempty"`
	DockerImage string `json:"dockerImage,omitempty"`
}
type Config struct {
	Root       string `json:"root"`
	Directory  string `json:"directory"`
	Worker     string `json:"worker"`
	Library    string `json:"library"`
	FFmpeg     string `json:"ffmpeg"`
	FFprobe    string `json:"ffprobe"`
	Slots      []Slot `json:"slots"`
	QueueLimit int    `json:"queueLimit"`
}
type Pin struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}
type Start struct {
	ID           string `json:"id"`
	ConfigFile   string `json:"configFile"`
	Output       string `json:"output"`
	MemoryMB     int    `json:"memoryMB"`
	GPU          string `json:"gpu,omitempty"`
	MaxRestarts  int    `json:"maxRestarts"`
	LeaseSeconds int    `json:"leaseSeconds"`
	Pins         []Pin  `json:"pins"`
}
type View struct {
	ID           string           `json:"id"`
	State        string           `json:"state"`
	GPU          string           `json:"gpu,omitempty"`
	Attempts     int              `json:"attempts"`
	Frames       int              `json:"frames"`
	Created      time.Time        `json:"created"`
	LeaseUntil   time.Time        `json:"leaseUntil"`
	Output       string           `json:"output"`
	Report       string           `json:"report,omitempty"`
	LastError    string           `json:"lastError,omitempty"`
	LastResponse *worker.Response `json:"lastResponse,omitempty"`
}
type room struct {
	View    View
	Spec    Start
	cancel  context.CancelFunc
	input   io.WriteCloser
	inputMu sync.Mutex
	stop    bool
}
type Manager struct {
	mu           sync.Mutex
	config       Config
	all          map[string]*room
	queue        []string
	running      map[string]int
	memory       map[string]int
	runner       func(context.Context, *room, Slot) error
	quarantined  map[string]bool
	dockerRunner func(context.Context, ...string) ([]byte, error)
	closing      bool
}

var identifier = regexp.MustCompile("^[a-zA-Z0-9_-]{1,80}$")

func New(c Config) (*Manager, error) {
	if !filepath.IsAbs(c.Root) || !filepath.IsAbs(c.Directory) || len(c.Slots) < 1 || len(c.Slots) > 32 || c.QueueLimit < 0 || c.QueueLimit > 256 {
		return nil, errors.New("invalid room-server configuration")
	}
	if _, err := within(c.Root, c.Directory, true); err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	locals := 0
	for _, s := range c.Slots {
		if !identifier.MatchString(s.ID) || ids[s.ID] || s.Capacity < 1 || s.Capacity > 64 || s.MemoryMB < 64 {
			return nil, errors.New("invalid/duplicate GPU slot")
		}
		ids[s.ID] = true
		if s.DockerGPU == "" {
			locals++
		} else if !regexp.MustCompile("^GPU-[a-fA-F0-9-]{8,64}$").MatchString(s.DockerGPU) || !regexp.MustCompile("^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,240}$").MatchString(s.DockerImage) {
			return nil, errors.New("multi-GPU isolation requires a full GPU UUID and explicit container image")
		}
	}
	if locals > 1 {
		return nil, errors.New("multiple physical GPUs require isolated container slots")
	}
	if err := os.MkdirAll(c.Directory, 0700); err != nil {
		return nil, err
	}
	m := &Manager{config: c, all: map[string]*room{}, running: map[string]int{}, memory: map[string]int{}, quarantined: map[string]bool{}}
	entries, err := os.ReadDir(c.Directory)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if !e.IsDir() || !identifier.MatchString(e.Name()) {
			continue
		}
		if len(m.all) >= 1024 {
			return nil, errors.New("room history exceeds1024 entries")
		}
		b, err := os.ReadFile(filepath.Join(c.Directory, e.Name(), "state.json"))
		if err != nil {
			continue
		}
		if len(b) > 2*1024*1024 {
			return nil, errors.New("room state too large")
		}
		var r room
		if json.Unmarshal(b, &r) != nil || r.Spec.ID != e.Name() {
			return nil, errors.New("invalid persisted room state")
		}
		if active(r.View.State) {
			r.View.State = "interrupted"
			r.View.LastError = "server restarted; prior playback is not acknowledged"
			r.stop = true
			for _, slot := range c.Slots {
				if slot.ID == r.View.GPU && slot.DockerGPU != "" && r.View.Attempts > 0 {
					r.View.State = "cleanup_failed"
					r.View.LastError = errContainerCleanup.Error()
				}
			}
		}
		m.all[r.Spec.ID] = &r
		if r.View.State == "cleanup_failed" {
			m.quarantined[r.View.GPU] = true
		}
	}
	return m, nil
}
func active(s string) bool {
	return s == "queued" || s == "starting" || s == "running" || s == "retrying" || s == "stopping"
}
func within(root, path string, newFile bool) (string, error) {
	a, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	check := a
	if newFile {
		check = filepath.Dir(a)
	}
	for {
		if _, err = os.Stat(check); err == nil {
			break
		}
		p := filepath.Dir(check)
		if p == check {
			return "", errors.New("no existing parent")
		}
		check = p
	}
	resolved, err := filepath.EvalSymlinks(check)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(root, resolved)
	lexical, e := filepath.Rel(root, a)
	if err != nil || e != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || lexical == ".." || strings.HasPrefix(lexical, ".."+string(os.PathSeparator)) {
		return "", errors.New("path escapes configured workspace")
	}
	return a, nil
}
func (m *Manager) persist(r *room) error {
	dir := filepath.Join(m.config.Directory, r.Spec.ID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if _, err := within(m.config.Root, dir, false); err != nil {
		return err
	}
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, "state-*.tmp")
	if err != nil {
		return err
	}
	tmp := file.Name()
	defer os.Remove(tmp)
	if _, err = file.Write(b); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "state.json"))
}
func (m *Manager) Start(s Start) (View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return View{}, errors.New("room manager is shutting down")
	}
	if old := m.all[s.ID]; old != nil {
		a, _ := json.Marshal(old.Spec)
		b, _ := json.Marshal(s)
		if string(a) != string(b) {
			return View{}, errors.New("room id already belongs to another request")
		}
		return old.View, nil
	}
	if len(m.all) >= 1024 || !identifier.MatchString(s.ID) || s.LeaseSeconds < 1 || s.LeaseSeconds > 172800 || s.MaxRestarts < 0 || s.MaxRestarts > 3 || s.MemoryMB < 1 || len(s.Pins) < 1 || len(s.Pins) > 1024 {
		return View{}, errors.New("invalid room request or history limit")
	}
	if _, err := within(m.config.Root, s.ConfigFile, false); err != nil {
		return View{}, err
	}
	if !strings.HasPrefix(strings.ToLower(s.Output), "srt://") {
		if _, err := within(m.config.Root, s.Output, true); err != nil {
			return View{}, err
		}
		if _, err := os.Stat(s.Output); err == nil {
			return View{}, errors.New("output already exists")
		}
	}
	c, err := worker.LoadConfig(s.ConfigFile)
	if err != nil {
		return View{}, err
	}
	for _, existing := range m.all {
		if active(existing.View.State) && existing.Spec.Output == s.Output {
			return View{}, errors.New("output destination is already reserved")
		}
	}
	files := []string{c.Skeleton, c.Atlas}
	if c.Shaders != "" {
		files = append(files, c.Shaders)
	}
	for _, a := range c.Audio {
		files = append(files, a.File)
	}
	for _, file := range files {
		if _, err := within(m.config.Root, file, false); err != nil {
			return View{}, err
		}
	}
	if _, err = worker.EncoderArgs(c, s.Output, false); err != nil {
		return View{}, err
	}
	for _, p := range s.Pins {
		if _, err := within(m.config.Root, p.Path, false); err != nil {
			return View{}, err
		}
	}
	if err = m.verify(s); err != nil {
		return View{}, err
	}
	eligible := false
	for _, slot := range m.config.Slots {
		if (s.GPU == "" || s.GPU == slot.ID) && s.MemoryMB <= slot.MemoryMB {
			eligible = true
		}
	}
	if !eligible {
		return View{}, errors.New("no GPU slot can satisfy this reservation")
	}
	if len(m.queue) >= m.config.QueueLimit && m.available(s) == nil {
		return View{}, errors.New("room queue is full")
	}
	now := time.Now()
	r := &room{Spec: s, View: View{ID: s.ID, State: "queued", Created: now, LeaseUntil: now.Add(time.Duration(s.LeaseSeconds) * time.Second), Output: worker.RedactOutput(s.Output)}}
	m.all[s.ID] = r
	m.queue = append(m.queue, s.ID)
	if err = m.persist(r); err != nil {
		delete(m.all, s.ID)
		m.queue = m.queue[:len(m.queue)-1]
		return View{}, err
	}
	m.dispatch()
	return r.View, nil
}
func (m *Manager) verify(s Start) error {
	foundConfig := false
	for _, p := range s.Pins {
		if p.Path == s.ConfigFile {
			foundConfig = true
		}
		f, err := os.Open(p.Path)
		if err != nil {
			return err
		}
		h := sha256.New()
		_, err = io.Copy(h, f)
		_ = f.Close()
		if err != nil {
			return err
		}
		if hex.EncodeToString(h.Sum(nil)) != p.SHA256 {
			return errors.New("pinned room config or asset changed")
		}
	}
	if !foundConfig {
		return errors.New("room config must be pinned")
	}
	return nil
}
func (m *Manager) available(s Start) *Slot {
	var best *Slot
	for i := range m.config.Slots {
		x := &m.config.Slots[i]
		if !m.quarantined[x.ID] && (s.GPU == "" || s.GPU == x.ID) && m.running[x.ID] < x.Capacity && m.memory[x.ID]+s.MemoryMB <= x.MemoryMB && (best == nil || m.running[x.ID] < m.running[best.ID]) {
			best = x
		}
	}
	return best
}
func (m *Manager) dispatch() {
	if m.closing {
		return
	}
	remaining := m.queue[:0]
	for _, id := range m.queue {
		r := m.all[id]
		if r.stop {
			continue
		}
		if time.Now().After(r.View.LeaseUntil) {
			r.View.State = "expired"
			_ = m.persist(r)
			continue
		}
		slot := m.available(r.Spec)
		if slot == nil {
			remaining = append(remaining, id)
			continue
		}
		r.View.State = "starting"
		r.View.GPU = slot.ID
		m.running[slot.ID]++
		m.memory[slot.ID] += r.Spec.MemoryMB
		ctx, cancel := context.WithDeadline(context.Background(), r.View.LeaseUntil)
		r.cancel = cancel
		_ = m.persist(r)
		go m.run(ctx, r, *slot)
	}
	m.queue = remaining
}
func (m *Manager) run(ctx context.Context, r *room, slot Slot) {
	defer func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.running[slot.ID]--
		m.memory[slot.ID] -= r.Spec.MemoryMB
		r.cancel()
		m.dispatch()
	}()
	for {
		m.mu.Lock()
		r.View.Attempts++
		r.View.State = "starting"
		r.View.LastError = ""
		_ = m.persist(r)
		m.mu.Unlock()
		err := m.verify(r.Spec)
		if err == nil {
			if m.runner != nil {
				err = m.runner(ctx, r, slot)
			} else {
				err = m.process(ctx, r, slot)
			}
		}
		m.mu.Lock()
		if errors.Is(err, errContainerCleanup) {
			r.View.State = "cleanup_failed"
			r.View.LastError = errContainerCleanup.Error()
			m.quarantined[slot.ID] = true
		} else if r.stop {
			r.View.State = "stopped"
		} else if ctx.Err() != nil {
			r.View.State = "expired"
		} else if err == nil {
			r.View.State = "completed"
		} else {
			r.View.State = "failed"
			if r.View.LastError == "" {
				r.View.LastError = "worker failed; inspect the owned attempt report"
			}
		}
		retry := err != nil && !errors.Is(err, errContainerCleanup) && !r.stop && ctx.Err() == nil && r.View.Attempts <= r.Spec.MaxRestarts
		if retry {
			r.View.State = "retrying"
		}
		_ = m.persist(r)
		m.mu.Unlock()
		if !retry {
			return
		}
		timer := time.NewTimer(time.Duration(1<<uint(r.View.Attempts-1)) * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
}
func (m *Manager) process(ctx context.Context, r *room, slot Slot) (err error) {
	dir := filepath.Join(m.config.Directory, r.Spec.ID)
	attempt := r.View.Attempts
	cfg, err := worker.LoadConfig(r.Spec.ConfigFile)
	if err != nil {
		return err
	}
	configPath := filepath.Join(dir, fmt.Sprintf("session-%d.json", attempt))
	report := filepath.Join(dir, fmt.Sprintf("report-%d.json", attempt))
	output := r.Spec.Output
	if !strings.HasPrefix(strings.ToLower(output), "srt://") {
		ext := filepath.Ext(output)
		output = filepath.Join(dir, fmt.Sprintf("video-attempt-%d", attempt)+ext)
	}
	command := ""
	var args []string
	if slot.DockerGPU != "" {
		if runtime.GOOS != "linux" {
			return errors.New("GPU container slots require a Linux host")
		}
		defer func() { err = errors.Join(err, m.cleanupContainer(r)) }()
		remap := func(p string) string {
			rel, _ := filepath.Rel(m.config.Root, p)
			return "/work/" + filepath.ToSlash(rel)
		}
		cfg.Skeleton = remap(cfg.Skeleton)
		cfg.Atlas = remap(cfg.Atlas)
		cfg.Shaders = "/app/shaders"
		for i := range cfg.Audio {
			cfg.Audio[i].File = remap(cfg.Audio[i].File)
		}
		command = "docker"
		args = []string{"--host", "unix:///var/run/docker.sock", "run", "--rm", "-i", "--cidfile", filepath.Join(dir, fmt.Sprintf("container-%d.cid", attempt)), "--label", "spine-mcp-owner=" + m.ownerLabel(), "--label", "spine-mcp-room=" + r.Spec.ID, "--gpus", "device=" + slot.DockerGPU, "-e", "NVIDIA_DRIVER_CAPABILITIES=graphics,video,compute,utility", "-v", m.config.Root + ":/work", slot.DockerImage, "-config", remap(configPath), "-report", remap(report), "-control-stdin", "-stop-on-control-eof"}
		if strings.HasPrefix(strings.ToLower(output), "srt://") {
			args = append(args, "-output", output)
		} else {
			args = append(args, "-output", remap(output))
		}
	} else {
		command = m.config.Worker
		args = []string{"-config", configPath, "-native", m.config.Library, "-ffmpeg", m.config.FFmpeg, "-ffprobe", m.config.FFprobe, "-control-stdin", "-stop-on-control-eof", "-output", output, "-report", report}
	}
	b, _ := json.Marshal(cfg)
	if err = os.WriteFile(configPath, b, 0600); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, command, args...)
	hideProcess(cmd)
	cmd.WaitDelay = 3 * time.Second
	input, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var log cappedLog
	cmd.Stderr = &log
	if err = cmd.Start(); err != nil {
		return err
	}
	cleanup, trackErr := trackProcess(cmd)
	if trackErr != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return trackErr
	}
	defer cleanup()
	m.mu.Lock()
	r.input = input
	r.View.Report = report
	m.mu.Unlock()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		var event worker.Event
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			continue
		}
		m.mu.Lock()
		if event.Event == "ready" {
			r.View.State = "running"
		}
		if event.Event == "error" {
			if len(event.Message) > 512 {
				event.Message = event.Message[:512]
			}
			r.View.LastError = event.Message
		}
		if event.Frames > r.View.Frames {
			r.View.Frames = event.Frames
		}
		if event.Response != nil {
			r.View.LastResponse = event.Response
		}
		m.mu.Unlock()
	}
	err = errors.Join(cmd.Wait(), scanner.Err())
	r.inputMu.Lock()
	_ = input.Close()
	r.inputMu.Unlock()
	m.mu.Lock()
	r.input = nil
	m.mu.Unlock()
	if err == nil && !strings.HasPrefix(strings.ToLower(output), "srt://") {
		if _, e := os.Stat(r.Spec.Output); e == nil {
			return errors.New("final output appeared during rendering")
		}
		if err = os.MkdirAll(filepath.Dir(r.Spec.Output), 0700); err == nil {
			err = os.Link(output, r.Spec.Output)
		}
	}
	return err
}
func (m *Manager) Get(id string) (View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.all[id]
	if r == nil {
		return View{}, errors.New("room not found")
	}
	return r.View, nil
}
func (m *Manager) List() []View {
	m.mu.Lock()
	defer m.mu.Unlock()
	a := make([]View, 0, len(m.all))
	for _, r := range m.all {
		a = append(a, r.View)
	}
	return a
}
func (m *Manager) Tick() { m.mu.Lock(); defer m.mu.Unlock(); m.dispatch() }
func (m *Manager) Shutdown(ctx context.Context) error {
	m.mu.Lock()
	m.closing = true
	ids := make([]string, 0, len(m.all))
	for id := range m.all {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		_, _ = m.Stop(id)
	}
	for {
		busy := false
		for _, v := range m.List() {
			if v.State == "cleanup_failed" {
				return errContainerCleanup
			}
			if active(v.State) {
				busy = true
			}
		}
		if !busy {
			return nil
		}
		select {
		case <-ctx.Done():
			m.mu.Lock()
			for _, r := range m.all {
				if active(r.View.State) && r.cancel != nil {
					r.cancel()
				}
			}
			m.mu.Unlock()
			return ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
}
func (m *Manager) Control(id string, c worker.Command) error {
	body, err := json.Marshal(c)
	if err != nil || len(body) > 4096 {
		return errors.New("room control exceeds4KiB")
	}
	switch c.Method {
	case "play", "pause", "resume", "speed", "skin", "seek", "transform":
	default:
		return errors.New("unsupported room control")
	}
	m.mu.Lock()
	r := m.all[id]
	if r == nil || r.View.State != "running" || r.input == nil {
		m.mu.Unlock()
		return errors.New("room is not ready")
	}
	input := r.input
	m.mu.Unlock()
	r.inputMu.Lock()
	defer r.inputMu.Unlock()
	return json.NewEncoder(input).Encode(c)
}
func (m *Manager) Stop(id string) (View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.all[id]
	if r == nil {
		return View{}, errors.New("room not found")
	}
	if r.View.State == "cleanup_failed" {
		r.View.State = "stopping"
		go func() {
			err := m.cleanupContainer(r)
			m.mu.Lock()
			defer m.mu.Unlock()
			if err != nil {
				r.View.State = "cleanup_failed"
				r.View.LastError = err.Error()
			} else {
				r.View.State = "stopped"
				r.View.LastError = ""
				delete(m.quarantined, r.View.GPU)
			}
			_ = m.persist(r)
			m.dispatch()
		}()
		return r.View, m.persist(r)
	}
	r.stop = true
	if active(r.View.State) {
		if r.cancel != nil {
			r.View.State = "stopping"
			if r.input == nil {
				r.cancel()
			} else {
				input := r.input
				go func() {
					r.inputMu.Lock()
					_ = json.NewEncoder(input).Encode(worker.Command{Method: "shutdown"})
					r.inputMu.Unlock()
					time.Sleep(5 * time.Second)
					m.mu.Lock()
					defer m.mu.Unlock()
					if active(r.View.State) {
						r.cancel()
					}
				}()
			}
		} else {
			r.View.State = "stopped"
		}
	}
	_ = m.persist(r)
	m.dispatch()
	return r.View, nil
}

type cappedLog struct {
	sync.Mutex
	b []byte
}

func (l *cappedLog) Write(p []byte) (int, error) {
	l.Lock()
	defer l.Unlock()
	l.b = append(l.b, p...)
	if len(l.b) > 16384 {
		l.b = l.b[len(l.b)-16384:]
	}
	return len(p), nil
}
