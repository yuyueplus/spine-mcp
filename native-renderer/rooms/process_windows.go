//go:build windows

package rooms

import (
	"errors"
	"os/exec"
	"syscall"
	"unsafe"
)

func hideProcess(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
func trackProcess(c *exec.Cmd) (func(), error) {
	kernel := syscall.NewLazyDLL("kernel32.dll")
	job, _, _ := kernel.NewProc("CreateJobObjectW").Call(0, 0)
	if job == 0 {
		return nil, errors.New("cannot create owned process job")
	}
	// JOBOBJECT_EXTENDED_LIMIT_INFORMATION: BasicLimitInformation.LimitFlags.
	info := make([]byte, 144)
	*(*uint32)(unsafe.Pointer(&info[16])) = 0x2000
	ok, _, _ := kernel.NewProc("SetInformationJobObject").Call(job, 9, uintptr(unsafe.Pointer(&info[0])), uintptr(len(info)))
	handle, _, _ := kernel.NewProc("OpenProcess").Call(0x0100|0x0001, 0, uintptr(c.Process.Pid))
	if ok != 0 && handle != 0 {
		ok, _, _ = kernel.NewProc("AssignProcessToJobObject").Call(job, handle)
	}
	if handle != 0 {
		syscall.CloseHandle(syscall.Handle(handle))
	}
	if ok == 0 {
		syscall.CloseHandle(syscall.Handle(job))
		return nil, errors.New("cannot attach owned worker process tree")
	}
	return func() { syscall.CloseHandle(syscall.Handle(job)) }, nil
}
