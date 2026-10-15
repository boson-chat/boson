package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSealOpenMatchesElectronLayout(t *testing.T) {
	// Made by Node's crypto (aes-256-gcm, key 32×0x07, iv 12×0x03) in the
	// Electron secure store's iv||tag||ciphertext layout.
	const fromNode = "AwMDAwMDAwMDAwMDFML3kGt2sgEQWKHwNM4H7labwHE/XH6g5tM="
	key := bytes.Repeat([]byte{7}, 32)
	got, err := open(key, fromNode)
	if err != nil || got != "secret ✓" {
		t.Fatalf("open(node vector) = %q, %v", got, err)
	}
	ct, err := seal(key, "round trip")
	if err != nil {
		t.Fatal(err)
	}
	if back, err := open(key, ct); err != nil || back != "round trip" {
		t.Fatalf("round trip = %q, %v", back, err)
	}
	if _, err := open(bytes.Repeat([]byte{8}, 32), ct); err == nil {
		t.Fatal("opened with the wrong key")
	}
}

func TestSecureStoreDerivedMode(t *testing.T) {
	dir := t.TempDir()
	s := NewSecureStore(dir, "derived")
	if s.Mode() != "derived" {
		t.Fatalf("mode = %s", s.Mode())
	}
	if err := s.Set("boson.bouncer.v1", "creds"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, storeFile))
	if !strings.Contains(string(raw), `"boson.bouncer.v1":"fb1:`) || strings.Contains(string(raw), "creds") {
		t.Fatalf("stored file: %s", raw)
	}
	if fi, _ := os.Stat(filepath.Join(dir, storeFile)); fi.Mode().Perm() != 0o600 {
		t.Fatalf("file mode %v", fi.Mode().Perm())
	}

	// A fresh store (next launch) reads it back.
	s2 := NewSecureStore(dir, "derived")
	if v := s2.Get("boson.bouncer.v1"); v == nil || *v != "creds" {
		t.Fatalf("reload: %v", v)
	}
	if err := s2.Remove("boson.bouncer.v1"); err != nil || s2.Get("boson.bouncer.v1") != nil {
		t.Fatal("remove failed")
	}
}

func TestSecureStoreUnreadableValuesAreMissing(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, storeFile), []byte(`{"a":"ks1:AAAA","b":"untagged","c":"fb1:!!notbase64","d":7}`), 0o600)
	s := NewSecureStore(dir, "derived")
	for _, k := range []string{"a", "b", "c", "d", "missing"} {
		if v := s.Get(k); v != nil {
			t.Errorf("%s = %q, want missing", k, *v)
		}
	}

	// A corrupt file is replaced on the next write.
	_ = os.WriteFile(filepath.Join(dir, storeFile), []byte("{nope"), 0o600)
	s = NewSecureStore(dir, "derived")
	if err := s.Set("k", "v"); err != nil {
		t.Fatal(err)
	}
	if v := NewSecureStore(dir, "derived").Get("k"); v == nil || *v != "v" {
		t.Fatalf("after corrupt file: %v", v)
	}
}
