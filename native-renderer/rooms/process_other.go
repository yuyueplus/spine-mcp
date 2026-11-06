//go:build !windows

package rooms

import (
	"os/exec"
	"syscall"
)

func hideProcess(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func trackProcess(c *exec.Cmd) (func(), error) {
	return func() { _ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL) }, nil
}
