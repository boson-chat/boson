package main

import (
	"encoding/base64"
	"os"
	"testing"
)

func TestApplyDevEnv(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("BOSON_DEV_KEPT", "mine")
	os.Unsetenv("BOSON_DEV_PLAIN")
	os.Unsetenv("BOSON_DEV_FILE")
	t.Cleanup(func() { os.Unsetenv("BOSON_DEV_PLAIN"); os.Unsetenv("BOSON_DEV_FILE") })
	doc := `{"version":1}`
	env := "# a comment\nBOSON_DEV_PLAIN=a=b\nBOSON_DEV_KEPT=theirs\nBOSON_DEV_FILE@=" + base64.StdEncoding.EncodeToString([]byte(doc)) + "\n"
	if err := applyDevEnv(base64.StdEncoding.EncodeToString([]byte(env)), dir); err != nil {
		t.Fatal(err)
	}
	if v := os.Getenv("BOSON_DEV_PLAIN"); v != "a=b" {
		t.Fatalf("plain %q", v)
	}
	if v := os.Getenv("BOSON_DEV_KEPT"); v != "mine" {
		t.Fatalf("the process's own setting was replaced: %q", v)
	}
	p := os.Getenv("BOSON_DEV_FILE")
	if b, err := os.ReadFile(p); err != nil || string(b) != doc {
		t.Fatalf("file setting %q: %q %v", p, b, err)
	}
	if err := applyDevEnv("", dir); err != nil {
		t.Fatal(err)
	}
	if err := applyDevEnv("!!", dir); err == nil {
		t.Fatal("bad base64 accepted")
	}
}

// The Android emulator's 10.0.2.2 is the host's loopback: dev builds treat
// it as one there (a local quicvoiced's self-signed certificate), and only
// there.
func TestEmulatorHostIsLoopback(t *testing.T) {
	if !isLoopbackHost("127.0.0.1") || !isLoopbackHost("localhost") || isLoopbackHost("10.0.0.2") {
		t.Fatal("loopback basics")
	}
	if got, want := isLoopbackHost("10.0.2.2"), emulatorHost; got != want {
		t.Fatalf("10.0.2.2 loopback %v, want %v on this platform", got, want)
	}
}
