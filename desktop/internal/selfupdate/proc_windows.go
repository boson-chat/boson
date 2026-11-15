//go:build windows

package selfupdate

import (
	"os/exec"
	"syscall"
	"time"
)

const (
	createNewProcessGroup = 0x00000200
	synchronize           = 0x00100000
)

func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewProcessGroup}
}

func waitExit(pid int, timeout time.Duration) {
	h, err := syscall.OpenProcess(synchronize, false, uint32(pid))
	if err != nil {
		return // gone already
	}
	defer syscall.CloseHandle(h)
	syscall.WaitForSingleObject(h, uint32(timeout/time.Millisecond))
}
