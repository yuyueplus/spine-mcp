package rooms

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/yuyueplus/spine-mcp/native-renderer/worker"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func fixture(t *testing.T) (*Manager, Start) {
	t.Helper()
	root := t.TempDir()
	cfg := worker.DefaultConfig()
	cfg.Skeleton = filepath.Join(root, "skeleton.skel")
	cfg.Atlas = filepath.Join(root, "skeleton.atlas")
	cfg.Frames = 10
	cfg.Width = 64
	cfg.Height = 64
	_ = os.WriteFile(cfg.Skeleton, []byte("pinned"), 0600)
	_ = os.WriteFile(cfg.Atlas, []byte("pinned"), 0600)
	b, _ := json.Marshal(cfg)
	file := filepath.Join(root, "config.json")
	_ = os.WriteFile(file, b, 0600)
	h := sha256.Sum256(b)
	m, e := New(Config{Root: root, Directory: filepath.Join(root, "rooms"), Slots: []Slot{{ID: "local", Capacity: 1, MemoryMB: 256}}, QueueLimit: 1})
	if e != nil {
		t.Fatal(e)
	}
	return m, Start{ID: "first", ConfigFile: file, Output: filepath.Join(root, "first.ts"), MemoryMB: 128, LeaseSeconds: 10, Pins: []Pin{{file, hex.EncodeToString(h[:])}}}
}
func wait(t *testing.T, m *Manager, id, state string) View {
	t.Helper()
	until := time.Now().Add(4 * time.Second)
	for time.Now().Before(until) {
		v, e := m.Get(id)
		if e == nil && v.State == state {
			return v
		}
		time.Sleep(5 * time.Millisecond)
	}
	v, _ := m.Get(id)
	t.Fatalf("wanted %s got %+v", state, v)
	return v
}
func TestReservationsQueueAndStop(t *testing.T) {
	m, a := fixture(t)
	m.runner = func(ctx context.Context, _ *room, _ Slot) error { <-ctx.Done(); return ctx.Err() }
	v, e := m.Start(a)
	if e != nil || v.State != "starting" {
		t.Fatal(v, e)
	}
	replay, e := m.Start(a)
	if e != nil || replay.ID != v.ID {
		t.Fatal("idempotent start failed")
	}
	b := a
	b.ID = "second"
	b.Output = filepath.Join(m.config.Root, "second.ts")
	v, e = m.Start(b)
	if e != nil || v.State != "queued" {
		t.Fatal(v, e)
	}
	c := b
	c.ID = "third"
	c.Output = filepath.Join(m.config.Root, "third.ts")
	if _, e = m.Start(c); e == nil {
		t.Fatal("queue exceeded bound")
	}
	if _, e = m.Stop(a.ID); e != nil {
		t.Fatal(e)
	}
	wait(t, m, a.ID, "stopped")
	wait(t, m, b.ID, "starting")
	_, _ = m.Stop(b.ID)
	wait(t, m, b.ID, "stopped")
}
func TestRetryAndPinnedDrift(t *testing.T) {
	m, a := fixture(t)
	a.MaxRestarts = 1
	var calls atomic.Int32
	m.runner = func(_ context.Context, _ *room, _ Slot) error { calls.Add(1); return errors.New("driver reset") }
	if _, e := m.Start(a); e != nil {
		t.Fatal(e)
	}
	v := wait(t, m, a.ID, "failed")
	if calls.Load() != 2 || v.Attempts != 2 {
		t.Fatal(v, calls.Load())
	}
}
func TestFailedWorkerRetryRejectsChangedInput(t *testing.T) {
	m, a := fixture(t)
	a.MaxRestarts = 1
	var calls atomic.Int32
	m.runner = func(_ context.Context, _ *room, _ Slot) error {
		calls.Add(1)
		_ = os.WriteFile(a.ConfigFile, []byte("{}"), 0600)
		return errors.New("crash")
	}
	if _, e := m.Start(a); e != nil {
		t.Fatal(e)
	}
	wait(t, m, a.ID, "failed")
	if calls.Load() != 1 {
		t.Fatal("changed source was rendered")
	}
}
func TestLeasesCapacityAndRequestIdentity(t *testing.T) {
	m, a := fixture(t)
	a.LeaseSeconds = 1
	m.runner = func(ctx context.Context, _ *room, _ Slot) error { <-ctx.Done(); return ctx.Err() }
	if _, e := m.Start(a); e != nil {
		t.Fatal(e)
	}
	changed := a
	changed.MemoryMB = 64
	if _, e := m.Start(changed); e == nil {
		t.Fatal("request id conflict accepted")
	}
	wait(t, m, a.ID, "expired")
	huge := a
	huge.ID = "huge"
	huge.MemoryMB = 300
	if _, e := m.Start(huge); e == nil {
		t.Fatal("VRAM reservation exceeded")
	}
	outside := a
	outside.ID = "outside"
	outside.ConfigFile = filepath.Join(m.config.Root, "..", "other.json")
	if _, e := m.Start(outside); e == nil {
		t.Fatal("workspace escaped")
	}
}
func TestGPUIsolationAndIndependentSlotSelection(t *testing.T) {
	m, a := fixture(t)
	c := m.config
	c.Slots = []Slot{{ID: "a", Capacity: 1, MemoryMB: 256}, {ID: "b", Capacity: 1, MemoryMB: 256}}
	if _, e := New(c); e == nil {
		t.Fatal("two local slots must not claim physical GPU isolation")
	}
	c.Slots = []Slot{{ID: "a", Capacity: 1, MemoryMB: 256, DockerGPU: "GPU-11111111", DockerImage: "renderer:test"}, {ID: "b", Capacity: 1, MemoryMB: 256, DockerGPU: "GPU-22222222", DockerImage: "renderer:test"}}
	m, e := New(c)
	if e != nil {
		t.Fatal(e)
	}
	m.runner = func(ctx context.Context, _ *room, _ Slot) error { <-ctx.Done(); return ctx.Err() }
	x, e := m.Start(a)
	if e != nil {
		t.Fatal(e)
	}
	b := a
	b.ID = "other"
	b.Output = filepath.Join(c.Root, "other.ts")
	y, e := m.Start(b)
	if e != nil || x.GPU == y.GPU {
		t.Fatal(x, y, e)
	}
	_, _ = m.Stop(a.ID)
	_, _ = m.Stop(b.ID)
	wait(t, m, a.ID, "stopped")
	wait(t, m, b.ID, "stopped")
}
func TestManagerShutdownWaitsForOwnedWorkersAndRejectsNewStarts(t *testing.T) {
	m, a := fixture(t)
	m.runner = func(ctx context.Context, _ *room, _ Slot) error { <-ctx.Done(); return ctx.Err() }
	if _, err := m.Start(a); err != nil {
		t.Fatal(err)
	}
	b := a
	b.ID = "queued"
	b.Output = filepath.Join(m.config.Root, "queued.ts")
	if _, err := m.Start(b); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	for _, v := range m.List() {
		if v.State != "stopped" {
			t.Fatal(v)
		}
	}
	c := a
	c.ID = "new"
	if _, err := m.Start(c); err == nil {
		t.Fatal("new work accepted during shutdown")
	}
}
