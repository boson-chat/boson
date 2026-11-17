//go:build cgo && !server && (darwin || windows || android || (linux && videocapture))

package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	qvclient "github.com/boson-chat/quicvideo/client"
	"github.com/boson-chat/quicvideo/client/media"
	"github.com/boson-chat/quicvideo/gen/controlpb"
)

// nativeMedia is quicvideo's client/media: ScreenCaptureKit, AVFoundation
// and VideoToolbox on macOS (screen sharing from 12.3: it's weak-linked);
// WGC and Media Foundation on Windows; on Linux (with -tags videocapture,
// which needs FFmpeg, openh264 and PipeWire to build and run) the
// PipeWire portal, V4L2 and FFmpeg encoders. Linux release builds don't
// package those yet, so they watch but don't send.
type nativeMedia struct{}

func newVideoMedia() videoMedia { return nativeMedia{} }

// CanShareScreen: not on iOS yet (it needs a ReplayKit broadcast
// extension); macOS before 12.3 says so when asked (ErrScreenUnsupported).
func (nativeMedia) CanShareScreen() bool { return runtime.GOOS != "ios" && runtime.GOOS != "android" }

// CanShareSound: a screen share can carry its sound (macOS 13+).
func (nativeMedia) CanShareSound() bool { return media.ScreenAudioSupported() }

func (nativeMedia) Cameras() ([]VideoCamera, error) {
	cams, err := media.ListCameras()
	if err != nil {
		return nil, err
	}
	def, _ := media.DefaultCamera(cams)
	out := make([]VideoCamera, 0, len(cams))
	for _, c := range cams {
		out = append(out, VideoCamera{ID: c.ID, Name: c.Name, Kind: string(c.Kind), Facing: c.Facing, Default: c.ID == def.ID, Unavailable: c.Unavailable})
	}
	return out, nil
}

func (nativeMedia) Screens() ([]VideoSource, error) {
	ds, ws, err := media.ListScreens()
	if err != nil {
		return nil, err
	}
	var out []VideoSource
	for i, d := range ds {
		if d.ID == media.PortalPicker {
			return []VideoSource{{ID: "", Name: "Choose a screen or window…", Kind: "picker"}}, nil
		}
		name := fmt.Sprintf("Screen %d", i+1)
		if d.Main {
			name += " (main)"
		}
		out = append(out, VideoSource{ID: "display:" + strconv.FormatUint(uint64(d.ID), 10), Name: name, Kind: "display",
			Width: d.Width, Height: d.Height, Main: d.Main, HasSelf: d.HasSelf})
	}
	for _, w := range ws {
		name := w.App
		if w.Title != "" {
			name = w.Title + " — " + w.App
		}
		out = append(out, VideoSource{ID: "window:" + strconv.FormatUint(uint64(w.ID), 10), Name: name, Kind: "window",
			Width: w.Width, Height: w.Height, App: w.App, Title: w.Title, Icon: appIcon(w.BundleID)})
	}
	return out, nil
}

// App icons for the picker's window list (data: URLs), once per app.
var (
	iconMu    sync.Mutex
	iconCache = map[string]string{}
)

func appIcon(bundleID string) string {
	if bundleID == "" {
		return ""
	}
	iconMu.Lock()
	defer iconMu.Unlock()
	if url, ok := iconCache[bundleID]; ok {
		return url
	}
	url := ""
	if b, err := media.AppIcon(bundleID, 64); err == nil {
		url = "data:image/png;base64," + base64.StdEncoding.EncodeToString(b)
	}
	iconCache[bundleID] = url
	return url
}

func (nativeMedia) StartCamera(ctx context.Context, c *qvclient.Client, id string, preview func(int, int, []byte), onEnd func(error)) (videoShare, error) {
	if err := cameraAllowed(); err != nil {
		return nil, err
	}
	name, facing := "camera", ""
	if cams, err := media.ListCameras(); err == nil {
		def, _ := media.DefaultCamera(cams)
		for _, cam := range cams {
			if cam.ID == id || (id == "" && def.ID == cam.ID) {
				name, facing = cam.Name, cam.Facing
			}
		}
	}
	// Follow the phone's orientation while this camera runs (Android).
	cameraTurning(true)
	release := sync.OnceFunc(func() { cameraTurning(false) })
	share, err := startNativeShare(ctx, c, controlpb.TrackKind_CAMERA, name, "", preview, func(err error) { release(); onEnd(err) },
		func(push func(media.CapturedFrame)) (media.Source, error) {
			return media.StartCamera(media.CameraOptions{ID: id, Width: 1280, Height: 720, FPS: 30}, push)
		})
	if err != nil {
		release()
		return nil, err
	}
	return &cameraShare{videoShare: share, facing: facing, release: release}, nil
}

// cameraShare is a camera's share: it knows which way the camera faces,
// and stops following the phone's orientation when it stops.
type cameraShare struct {
	videoShare
	facing  string
	release func()
}

func (s *cameraShare) Facing() string { return s.facing }
func (s *cameraShare) Stop() {
	s.release()
	s.videoShare.Stop()
}

func (nativeMedia) StartScreen(ctx context.Context, c *qvclient.Client, id, mode string, sound bool, onEnd func(error)) (videoShare, error) {
	m := media.ScreenMotion
	if mode == string(media.ScreenDetail) {
		m = media.ScreenDetail
	}
	// The share's sound, where the platform and the server can: captured
	// with the picture (and with every source "Switch to this" picks).
	var snd *screenSound
	if sound && media.ScreenAudioSupported() && c != nil && c.ServerCan(qvclient.CapScreenAudio) {
		var err error
		if snd, err = newScreenSound(); err != nil {
			log.Printf("video: share sound: %v", err)
			snd = nil
		}
	}
	opts := func(id string) (media.ScreenOptions, string) {
		o := media.ScreenOptions{Cursor: true, Mode: m} // capture size and rate from the mode
		if snd != nil {
			o.Audio = snd.capture
		}
		name := "screen"
		switch kind, n, _ := strings.Cut(id, ":"); kind {
		case "display":
			v, _ := strconv.ParseUint(n, 10, 32)
			o.DisplayID = uint32(v)
		case "window":
			v, _ := strconv.ParseUint(n, 10, 32)
			o.WindowID, name = uint32(v), "window"
		default:
			o.DisplayID = media.PortalPicker
		}
		return o, name
	}
	o, name := opts(id)
	share, err := startNativeShare(ctx, c, controlpb.TrackKind_SCREEN, name, m, nil, onEnd, func(push func(media.CapturedFrame)) (media.Source, error) {
		return media.StartScreen(o, push)
	})
	if err != nil {
		if snd != nil {
			snd.stop()
		}
		return nil, err
	}
	if snd != nil {
		// No sound is better than no share: a refusal leaves the picture.
		if err := snd.publish(ctx, c, share.track.ID()); err != nil {
			log.Printf("video: share sound: %v", err)
			snd.stop()
		} else {
			share.sound = snd
		}
	}
	share.switchTo = func(id string, push func(media.CapturedFrame)) (media.Source, string, error) {
		o, name := opts(id)
		src, err := media.StartScreen(o, push)
		return src, name, err
	}
	return share, nil
}

// Thumbnail is a small JPEG of a display or window, for the picker.
func (nativeMedia) Thumbnail(id string, maxW int) ([]byte, error) {
	kind, n, _ := strings.Cut(id, ":")
	v, err := strconv.ParseUint(n, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("no such source %q", id)
	}
	switch kind {
	case "display":
		return media.ScreenThumbnail(uint32(v), 0, maxW)
	case "window":
		return media.ScreenThumbnail(0, uint32(v), maxW)
	}
	return nil, fmt.Errorf("no such source %q", id)
}

func (nativeMedia) PreviewCamera(id string, preview func(int, int, []byte), onEnd func(error)) (func(), string, error) {
	if err := cameraAllowed(); err != nil {
		return nil, "", err
	}
	facing := ""
	if cams, err := media.ListCameras(); err == nil {
		def, _ := media.DefaultCamera(cams)
		for _, cam := range cams {
			if cam.ID == id || (id == "" && def.ID == cam.ID) {
				facing = cam.Facing
			}
		}
	}
	var mu sync.Mutex
	var last time.Time
	src, err := media.StartCamera(media.CameraOptions{ID: id, Width: 1280, Height: 720, FPS: 30}, func(f media.CapturedFrame) {
		mu.Lock()
		due := time.Since(last) > 66*time.Millisecond
		if due {
			last = time.Now()
		}
		mu.Unlock()
		if !due {
			return
		}
		if img, err := media.ToRGBA(f.Picture, 320); err == nil {
			preview(img.Bounds().Dx(), img.Bounds().Dy(), img.Pix)
		}
	})
	if err != nil {
		return nil, "", err
	}
	done := make(chan struct{})
	if e, ok := src.(media.Ender); ok {
		go func() {
			select {
			case err := <-e.Ended():
				onEnd(err)
			case <-done:
			}
		}()
	}
	var once sync.Once
	return func() { once.Do(func() { close(done); src.Stop() }) }, facing, nil
}

// nativeShare is a running source + publisher + track.
type nativeShare struct {
	pub    *media.Publisher
	track  *qvclient.LocalTrack
	layers int
	push   func(media.CapturedFrame)
	once   sync.Once
	done   chan struct{}
	ended  chan error // the current source ended on its own
	// switchTo starts another source of the same kind (a screen share's
	// "Switch to this"); nil where the share can't switch.
	switchTo func(id string, push func(media.CapturedFrame)) (media.Source, string, error)

	mu   sync.Mutex
	name string
	src  media.Source

	sound *screenSound // a screen share's sound, when it's sent
}

// SendingSound: the share carries its sound.
func (s *nativeShare) SendingSound() bool { return s.sound != nil }

func (s *nativeShare) Name() string { s.mu.Lock(); defer s.mu.Unlock(); return s.name }

// watch forwards src's own end (unplugged, stopped from the system UI) to
// the share, unless src has been switched away from by then.
func (s *nativeShare) watch(src media.Source) {
	e, ok := src.(media.Ender)
	if !ok {
		return
	}
	go func() {
		select {
		case err := <-e.Ended():
			s.mu.Lock()
			current := s.src == src
			s.mu.Unlock()
			if current {
				select {
				case s.ended <- err:
				default:
				}
			}
		case <-s.done:
		}
	}()
}

// Switch captures something else on the same track: the new source starts
// first, then the old one stops, so the others see no gap and no new tile.
// The encoders keep their sizes (a different shape is letterboxed).
func (s *nativeShare) Switch(id string) error {
	if s.switchTo == nil {
		return errors.New("this share can't switch")
	}
	src, name, err := s.switchTo(id, s.push)
	if err != nil {
		return err
	}
	s.mu.Lock()
	old := s.src
	s.src, s.name = src, name
	s.mu.Unlock()
	s.watch(src)
	old.Stop()
	for l := 0; l < s.layers; l++ {
		s.pub.KeyframeNeeded(uint32(l)) // a clean start of the new picture
	}
	return nil
}

// Stop releases the device first (the camera light goes off even if an
// encoder is slow), then stops the encoders and unpublishes.
func (s *nativeShare) Stop() {
	s.once.Do(func() {
		close(s.done)
		s.mu.Lock()
		src := s.src
		s.mu.Unlock()
		src.Stop()
		if s.sound != nil {
			s.sound.stop()
		}
		s.pub.Close()
		_ = s.track.Unpublish()
	})
}

// cameraStall: a camera that sends no picture for this long has stopped
// (screens only send frames when something changes, so they don't stall).
const cameraStall = 5 * time.Second

// startNativeShare starts a source, waits for its first picture (its
// size picks the layer ladder), publishes, and watches for the source
// ending. Like the quicvideo viewer's share lifecycle.
func startNativeShare(ctx context.Context, c *qvclient.Client, kind controlpb.TrackKind, name string, mode media.ScreenMode,
	preview func(int, int, []byte), onEnd func(error), start func(func(media.CapturedFrame)) (media.Source, error)) (*nativeShare, error) {
	if c == nil {
		return nil, errors.New("video: not connected")
	}
	camera := kind == controlpb.TrackKind_CAMERA
	var mu sync.Mutex
	var pub *media.Publisher
	var lastFrame atomic.Int64
	var lastPreview time.Time
	sized := make(chan [2]int, 1)
	push := func(f media.CapturedFrame) {
		lastFrame.Store(time.Now().UnixNano())
		if preview != nil && time.Since(lastPreview) > 66*time.Millisecond {
			lastPreview = time.Now()
			if img, err := media.ToRGBA(f.Picture, 320); err == nil {
				preview(img.Bounds().Dx(), img.Bounds().Dy(), img.Pix)
			}
		}
		mu.Lock()
		p := pub
		mu.Unlock()
		if p != nil {
			p.Push(f)
			return
		}
		w, h := f.Picture.Size()
		select {
		case sized <- [2]int{w, h}:
		default:
		}
	}
	src, err := start(push)
	if err != nil {
		return nil, err
	}
	var wh [2]int
	select {
	case wh = <-sized:
	case <-time.After(10 * time.Second):
		wh[0], wh[1] = src.Size()
	case <-ctx.Done():
		src.Stop()
		return nil, ctx.Err()
	}
	if wh[0] == 0 || wh[1] == 0 {
		src.Stop()
		return nil, fmt.Errorf("the %s delivered no picture in 10 s (is it in use by another app?)", name)
	}
	layers := media.CameraLayers(wh[0], wh[1], src.FPS())
	if !camera {
		layers = media.ScreenLayersFor(wh[0], wh[1], mode)
	}
	p, track, err := media.PublishTrack(ctx, c, kind, layers, media.DefaultEncoder, media.PublisherOptions{
		Screen:  !camera,
		Motion:  mode != media.ScreenDetail,
		OnError: func(l uint32, err error) { log.Printf("video: encoder layer %d: %v", l, err) },
	})
	if err != nil {
		src.Stop()
		return nil, err
	}
	mu.Lock()
	pub = p
	mu.Unlock()
	s := &nativeShare{name: name, src: src, pub: p, track: track, layers: len(layers), push: push,
		done: make(chan struct{}), ended: make(chan error, 1)}
	s.watch(src)
	go func() {
		ended := s.ended
		var tick <-chan time.Time
		if camera {
			t := time.NewTicker(time.Second)
			defer t.Stop()
			tick = t.C
		}
		for {
			select {
			case <-s.done:
				return
			case err := <-ended:
				s.Stop()
				onEnd(err)
				return
			case <-tick:
				if time.Since(time.Unix(0, lastFrame.Load())) > cameraStall {
					s.Stop()
					onEnd(fmt.Errorf("the camera sent no picture for %v", cameraStall))
					return
				}
			}
		}
	}()
	return s, nil
}
