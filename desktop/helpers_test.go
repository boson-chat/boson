package main

import (
	"testing"
	"time"
)

// waitFor polls ok for up to 2s. Shared by tests on every platform
// (files_test.go is desktop-only; voice_phone_test.go runs on phones too).
func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out")
}
