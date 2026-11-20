//go:build cgo && !server && (darwin || windows || android || (linux && videocapture))

package main

import (
	"testing"

	"github.com/boson-chat/quicvideo/client/media"
)

func TestCameraLadder(t *testing.T) {
	for q, want := range map[string][3]int{
		"auto": {int(media.CameraAuto), 1280, 720}, "": {int(media.CameraAuto), 1280, 720},
		"saver": {int(media.CameraDataSaver), 1280, 720}, "high": {int(media.CameraHigh), 1920, 1080},
	} {
		if l, w, h := cameraLadder(q); [3]int{int(l), w, h} != want {
			t.Errorf("%q: %v %dx%d", q, l, w, h)
		}
	}
}
