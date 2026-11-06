//go:build !windows

package worker

import "os/exec"

func hideProcess(*exec.Cmd) {}
