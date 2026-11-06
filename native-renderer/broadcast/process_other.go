//go:build !windows

package broadcast

import "os/exec"

func hideProcess(c *exec.Cmd) {}
