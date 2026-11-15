package selfupdate

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// RelaunchFlag hands the new process the old one's pid: it waits for that
// process to exit before starting up, so the single-instance lock is free
// (otherwise the relaunch would hand its args to the old copy and quit).
const RelaunchFlag = "--boson-relaunch-wait="

// Relaunch starts target (the copy just swapped in) as a new process that
// waits for this one to exit; the caller quits next. Data (the session, the
// secure store) is on disk, so the new copy picks up where this one left off.
// macOS goes through LaunchServices (open -n), as a Finder launch would;
// env (VAR=value) is passed on there, which a LaunchServices launch wouldn't
// otherwise inherit (elsewhere the child inherits this process's anyway).
func Relaunch(goos, target string, env []string) error {
	arg := RelaunchFlag + strconv.Itoa(os.Getpid())
	if goos == "darwin" {
		args := []string{"-n"}
		for _, e := range env {
			args = append(args, "--env", e)
		}
		args = append(args, "-a", target, "--args", arg)
		return exec.Command("/usr/bin/open", args...).Run()
	}
	cmd := exec.Command(target, arg)
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// WaitForRelaunch removes RelaunchFlag from args and, when it was there,
// waits up to timeout for that process to exit. Returns the other args.
func WaitForRelaunch(args []string, timeout time.Duration) []string {
	out := args[:0:0]
	pid := 0
	for _, a := range args {
		if v, ok := strings.CutPrefix(a, RelaunchFlag); ok {
			pid, _ = strconv.Atoi(v)
			continue
		}
		out = append(out, a)
	}
	if pid > 0 && pid != os.Getpid() {
		waitExit(pid, timeout)
	}
	return out
}
