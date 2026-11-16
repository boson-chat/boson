//go:build webkit && darwin && cgo && !server

package main

import (
	"os"
	"os/exec"
	"sync"
	"testing"
	"time"

	"github.com/boson-chat/quicvideo/client/media"
)

// TestVideoInWebKit runs real video into WebKit (the iOS and macOS apps'
// webview engine) and Chromium: VideoToolbox H.264 from two moving
// pattern sources, a camera (track 10) and a screen share (track 11), plus
// self-view previews, through the app's real frame hub, decoded by the
// browser's own WebCodecs. client/tests/video-webkit checks each tile
// draws a picture and keeps moving.
//
// VIDEO_TEST_REAL_SCREEN=1 shares this Mac's main display as track 11
// instead (ScreenCaptureKit: its real timestamps, at the screen's own
// pace; needs the Screen Recording permission).
//
//	go test -tags webkit -run TestVideoInWebKit .
func TestVideoInWebKit(t *testing.T) {
	var mu sync.Mutex
	force := map[uint32]bool{}
	hub, err := newFrameHub(func(id uint32) { mu.Lock(); force[id] = true; mu.Unlock() })
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	feed := func(id uint32, w, h int, preview bool, real bool) func() {
		enc, err := media.NewVTEncoder(media.EncoderConfig{Width: w, Height: h, FPS: 30, Bitrate: 1_500_000, GOP: time.Second, Screen: id == 11},
			func(f media.EncodedFrame) {
				if a, err := toAVC(f.Data); err == nil {
					hub.Frame(id, 0, f.CaptureUS, a)
				}
			})
		if err != nil {
			t.Fatal(err)
		}
		var last time.Time
		push := func(f media.CapturedFrame) {
			mu.Lock()
			k := force[id]
			force[id] = false
			mu.Unlock()
			_ = enc.Encode(f.Picture, f.CaptureUS, k)
			if preview && time.Since(last) > 66*time.Millisecond {
				last = time.Now()
				if img, err := media.ToRGBA(f.Picture, 320); err == nil {
					hub.Preview(img.Bounds().Dx(), img.Bounds().Dy(), img.Pix)
				}
			}
		}
		var src media.Source
		if real {
			src, err = media.StartScreen(media.ScreenOptions{MaxWidth: w, Cursor: true}, push)
		} else {
			src, err = media.NewPatternSource(w, h, 30, push)
		}
		if err != nil {
			t.Fatal(err)
		}
		return func() { src.Stop(); enc.Close() }
	}
	realScreen := os.Getenv("VIDEO_TEST_REAL_SCREEN") == "1"
	defer feed(10, 640, 360, true, false)()
	defer feed(11, 1280, 720, false, realScreen)()

	cmd := exec.Command("npx", "playwright", "test", "-c", "tests/video-webkit/playwright.config.ts")
	cmd.Dir = "../client"
	cmd.Env = append(os.Environ(), "FRAME_URL="+hub.URL())
	if realScreen {
		cmd.Env = append(cmd.Env, "REAL_SCREEN=1") // a still screen sends few frames: only require it drew
	}
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("playwright: %v", err)
	}
}
