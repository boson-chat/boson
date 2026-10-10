//go:build boson_e2ecover && !windows

package main

// Coverage flush for the real-app e2e suite. Only compiled into the
// coverage build client/scripts/e2e-stack.mjs makes
// (`go build -cover -tags boson_dev,boson_e2ecover`), never into a release
// binary.
//
// A `-cover` binary writes its counters to GOCOVERDIR only when it exits
// normally, but `serve` runs until it is killed. The suite's coverage report
// (client/tests/e2e-app/coverage/report.ts) sends SIGUSR1 instead and reads
// the snapshot this writes — counters are cumulative since the process
// started, so the newest snapshot covers the whole run.

import (
	"fmt"
	"os"
	"os/signal"
	"runtime/coverage"
	"syscall"
)

func init() {
	dir := os.Getenv("GOCOVERDIR")
	if dir == "" {
		return
	}
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGUSR1)
	go func() {
		for range ch {
			if err := writeCoverage(dir); err != nil {
				fmt.Fprintf(os.Stderr, "e2e coverage flush failed: %v\n", err)
				continue
			}
			fmt.Fprintf(os.Stderr, "e2e coverage flushed to %s\n", dir)
		}
	}()
}

func writeCoverage(dir string) error {
	if err := coverage.WriteMetaDir(dir); err != nil {
		return err
	}
	return coverage.WriteCountersDir(dir)
}
