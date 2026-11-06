package rooms

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestContainerCleanupRequiresExactOwnership(t *testing.T) {
	for _, owned := range []bool{false, true} {
		m, a := fixture(t)
		r := &room{Spec: a, View: View{ID: a.ID, Attempts: 1}}
		dir := filepath.Join(m.config.Directory, a.ID)
		_ = os.MkdirAll(dir, 0700)
		_ = os.WriteFile(filepath.Join(dir, "container-1.cid"), []byte(strings.Repeat("a", 64)), 0600)
		stopped := false
		m.dockerRunner = func(_ context.Context, args ...string) ([]byte, error) {
			joined := strings.Join(args, " ")
			if strings.Contains(joined, ".Config.Labels") {
				owner := m.ownerLabel()
				if !owned {
					owner = "another owner"
				}
				b, _ := json.Marshal(map[string]string{"spine-mcp-owner": owner, "spine-mcp-room": a.ID})
				return b, nil
			}
			if args[0] == "stop" {
				stopped = true
				return nil, nil
			}
			if strings.Contains(joined, ".State.Running") {
				return []byte("false"), nil
			}
			t.Fatal("unexpected Docker request", args)
			return nil, nil
		}
		err := m.cleanupContainer(r)
		if owned != (err == nil) || stopped != owned {
			t.Fatalf("ownership=%v err=%v stopped=%v", owned, err, stopped)
		}
	}
}
func TestUnverifiedCleanupQuarantinesSlotAndCanBeRetried(t *testing.T) {
	m, a := fixture(t)
	m.runner = func(ctx context.Context, r *room, _ Slot) error {
		if r.Spec.ID == a.ID {
			return errContainerCleanup
		}
		<-ctx.Done()
		return ctx.Err()
	}
	if _, err := m.Start(a); err != nil {
		t.Fatal(err)
	}
	wait(t, m, a.ID, "cleanup_failed")
	b := a
	b.ID = "queued"
	b.Output = filepath.Join(m.config.Root, "queued.ts")
	v, err := m.Start(b)
	if err != nil || v.State != "queued" {
		t.Fatal(v, err)
	}
	if _, err = m.Stop(a.ID); err != nil {
		t.Fatal(err)
	}
	wait(t, m, a.ID, "stopped")
	_, _ = m.Stop(b.ID)
	wait(t, m, b.ID, "stopped")
}
