package rooms

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var errContainerCleanup = errors.New("owned container shutdown could not be verified")

func (m *Manager) ownerLabel() string {
	h := sha256.Sum256([]byte(m.config.Directory))
	return hex.EncodeToString(h[:])
}
func (m *Manager) docker(ctx context.Context, args ...string) ([]byte, error) {
	if m.dockerRunner != nil {
		return m.dockerRunner(ctx, args...)
	}
	cmd := exec.CommandContext(ctx, "docker", append([]string{"--host", "unix:///var/run/docker.sock"}, args...)...)
	hideProcess(cmd)
	var output cappedLog
	cmd.Stdout = &output
	cmd.Stderr = &output
	err := cmd.Run()
	return output.b, err
}
func (m *Manager) cleanupContainer(r *room) error {
	file := filepath.Join(m.config.Directory, r.Spec.ID, fmt.Sprintf("container-%d.cid", r.View.Attempts))
	b, err := os.ReadFile(file)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return errors.Join(errContainerCleanup, err)
	}
	id := strings.TrimSpace(string(b))
	if !regexp.MustCompile("^[a-f0-9]{64}$").MatchString(id) {
		return errContainerCleanup
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	labels, e := m.docker(ctx, "inspect", "--format", "{{json .Config.Labels}}", id)
	if e != nil {
		ids, e := m.docker(ctx, "ps", "-a", "--no-trunc", "--filter", "id="+id, "--format", "{{.ID}}")
		if e == nil && strings.TrimSpace(string(ids)) == "" {
			return nil
		}
		return errContainerCleanup
	}
	var values map[string]string
	if json.Unmarshal(labels, &values) != nil || values["spine-mcp-owner"] != m.ownerLabel() || values["spine-mcp-room"] != r.Spec.ID {
		return errContainerCleanup
	}
	_, _ = m.docker(ctx, "stop", "--time", "5", id)
	state, e := m.docker(ctx, "inspect", "--format", "{{json .State.Running}}", id)
	if e == nil && strings.TrimSpace(string(state)) == "false" {
		return nil
	}
	ids, e := m.docker(ctx, "ps", "-a", "--no-trunc", "--filter", "id="+id, "--format", "{{.ID}}")
	if e == nil && strings.TrimSpace(string(ids)) == "" {
		return nil
	}
	return errContainerCleanup
}
