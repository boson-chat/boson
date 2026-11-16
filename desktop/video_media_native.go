//go:build cgo && !server && (darwin || windows || android || (linux && videocapture))

package main

import (
	"context"
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
		out = append(out, VideoSource{ID: "display:" + strconv.FormatUint(uint64(d.ID), 10), Name: name, Kind: "display", Width: d.Width, Height: d.Height})
	}
	for _, w := range ws {
		name := w.App
		if w.Title != "" {
			name = w.Title + " — " + w.App
		}
		out = append(out, VideoSource{ID: "window:" + strconv.FormatUint(uint64(w.ID), 10), Name: name, Kind: "window", Width: w.Width, Height: w.Height})
	}
	return out, nil
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
	share, err := startNativeShare(ctx, c, controlpb.TrackKind_CAMERA, name, preview, func(err error) { release(); onEnd(err) },
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

func (nativeMedia) StartScreen(ctx context.Context, c *qvclient.Client, id string, onEnd func(error)) (videoShare, error) {
	var o media.ScreenOptions
	o.FPS, o.Cursor = 15, true
	name := "screen"
	switch kind, n, _ := strings.Cut(id, ":"); kind {
	case "display":
		v, _ := strconv.ParseUint(n, 10, 32)
		o.DisplayID, name = uint32(v), "screen"
	case "window":
		v, _ := strconv.ParseUint(n, 10, 32)
		o.WindowID, name = uint32(v), "window"
	default:
		o.DisplayID = media.PortalPicker
	}
	return startNativeShare(ctx, c, controlpb.TrackKind_SCREEN, name, nil, onEnd, func(push func(media.CapturedFrame)) (media.Source, error) {
		return media.StartScreen(o, push)
	})
}

// nativeShare is a running source + publisher + track.
type nativeShare struct {
	name  string
	src   media.Source
	pub   *media.Publisher
	track *qvclient.LocalTrack
	once  sync.Once
	done  chan struct{}
}

func (s *nativeShare) Name() string { return s.name }

// Stop releases the device first (the camera light goes off even if an
// encoder is slow), then stops the encoders and unpublishes.
func (s *nativeShare) Stop() {
	s.once.Do(func() {
		close(s.done)
		s.src.Stop()
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
func startNativeShare(ctx context.Context, c *qvclient.Client, kind controlpb.TrackKind, name string,
	preview func(int, int, []byte), onEnd func(error), start func(func(media.CapturedFrame)) (media.Source, error)) (videoShare, error) {
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
		layers = media.ScreenLayers(wh[0], wh[1])
	}
	p, track, err := media.PublishTrack(ctx, c, kind, layers, media.DefaultEncoder, media.PublisherOptions{
		Screen:  !camera,
		OnError: func(l uint32, err error) { log.Printf("video: encoder layer %d: %v", l, err) },
	})
	if err != nil {
		src.Stop()
		return nil, err
	}
	mu.Lock()
	pub = p
	mu.Unlock()
	s := &nativeShare{name: name, src: src, pub: p, track: track, done: make(chan struct{})}
	go func() {
		var ended <-chan error
		if e, ok := src.(media.Ender); ok {
			ended = e.Ended()
		}
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
