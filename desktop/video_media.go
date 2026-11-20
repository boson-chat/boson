package main

import (
	"context"

	qvclient "github.com/boson-chat/quicvideo/client"
)

// videoMedia is capture + encode + publish: native on desktop builds with
// cgo (video_media_native.go, quicvideo's client/media), absent elsewhere
// (phones for now, the e2e server build), where calls can still be watched.
type videoMedia interface {
	Cameras() ([]VideoCamera, error)
	Screens() ([]VideoSource, error)
	// StartCamera captures the camera (id "" = the best one: built-in,
	// external, phone, virtual; a closed laptop's built-in is skipped) and
	// publishes it on c. preview gets small self-view pictures; onEnd is
	// called if the capture ends on its own (unplugged, an error, no
	// pictures).
	// quality (auto | saver | high) caps the layer ladder: 720p, 360p, or
	// 1080p when the camera has it (CameraQuality*).
	StartCamera(ctx context.Context, c *qvclient.Client, id, quality string, preview func(w, h int, rgba []byte), onEnd func(error)) (videoShare, error)
	// StartScreen shares a screen or window (VideoSource.ID; "" = the main
	// screen, or the system picker where there is one).
	// mode: "detail" (text, up to 1440p, 15 fps) or "motion" (default;
	// video and scrolling, 1080p, 30 fps): the capture, the layer ladder
	// and the encoder's content hint.
	// sound: also send what the shared screen or app plays (where the
	// media can: soundSharer), on a SCREEN_AUDIO track tied to the share.
	StartScreen(ctx context.Context, c *qvclient.Client, id, mode string, sound bool, onEnd func(error)) (videoShare, error)
	// Thumbnail is a small JPEG of a source (a VideoSource.ID), for the
	// picker; an error where there are none (Linux, Windows for now).
	Thumbnail(id string, maxW int) ([]byte, error)
	// PreviewCamera captures the camera for the self-view only: nothing
	// is encoded or sent (before joining a call, to check how you look).
	// stop releases the camera; onEnd is called if it ends on its own.
	PreviewCamera(id string, preview func(w, h int, rgba []byte), onEnd func(error)) (stop func(), facing string, err error)
}

// videoShare is a running capture + published track.
type videoShare interface {
	// Stop releases the device and unpublishes the track.
	Stop()
	// Name is what's shared ("FaceTime HD Camera", "Display 1").
	Name() string
}

// switchableShare is a screen share that can change what it captures
// without ending its track ("Switch to this" in the picker).
type switchableShare interface {
	Switch(id string) error
}

// facingShare is a camera share that knows which way its camera faces
// ("front", "back", "" for a webcam): the self-view is mirrored unless
// it's a back camera.
type facingShare interface {
	Facing() string
}

// VideoCamera is a camera to pick.
type VideoCamera struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Kind        string `json:"kind"`             // builtin | external | continuity | virtual
	Facing      string `json:"facing,omitempty"` // front | back | "" (a webcam)
	Default     bool   `json:"default"`
	Unavailable string `json:"unavailable,omitempty"`
}

// VideoSource is a screen or window to share.
type VideoSource struct {
	ID     string `json:"id"` // display:N | window:N | "" (system picker)
	Name   string `json:"name"`
	Kind   string `json:"kind"` // display | window | picker
	Width  int    `json:"width,omitempty"`
	Height int    `json:"height,omitempty"`
	// A window's app and title; its icon (a data: URL) where known.
	App   string `json:"app,omitempty"`
	Title string `json:"title,omitempty"`
	Icon  string `json:"icon,omitempty"`
	// A display: the main one; Boson's window is on it (sharing it shows
	// the call inside the share; Boson's window itself is left out).
	Main    bool `json:"main,omitempty"`
	HasSelf bool `json:"hasSelf,omitempty"`
}

// soundSharer is media that can send a screen share's sound (macOS 13+).
type soundSharer interface{ CanShareSound() bool }

// soundShare is a screen share that's sending its sound.
type soundShare interface{ SendingSound() bool }
