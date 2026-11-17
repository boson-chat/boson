//go:build cgo && !server && (darwin || windows || android || (linux && videocapture))

package main

import (
	"context"
	"errors"
	"log"
	"sync"
	"sync/atomic"

	qvclient "github.com/boson-chat/quicvideo/client"
	"github.com/boson-chat/quicvideo/client/media"
	controlpb "github.com/boson-chat/quicvideo/gen/controlpb"
	"gopkg.in/hraban/opus.v2"
)

// A screen share's sound, sending side (quicvideo's docs/screen-audio.md):
// the capture's 48 kHz mono samples become 20 ms Opus frames on a
// SCREEN_AUDIO track tied to the share. Each frame is stamped with its
// first sample's capture time, counted from the sample position so frames
// are exactly 20 ms apart (what receivers' timestamps are made from); a
// jump in the capture clock (a new source, a stall) restarts the count.
// Every frame decodes on its own; the first of each ~200 ms group is
// flagged keyframe, so a dropped group costs 200 ms of sound at most.
const (
	soundFrame      = 960 // 20 ms at 48 kHz
	soundFrameUS    = 20_000
	soundBitrate    = 64_000
	soundGroup      = 10     // frames per group
	soundResyncUS   = 40_000 // a capture clock jump that restarts the count
	soundQueue      = 64     // capture buffers waiting for the encoder
	soundMaxPayload = 1500   // an Opus packet at 64 kbit/s is ~160 bytes
	soundApp        = opus.AppAudio
)

// soundTrack is what screenSound needs of a published track
// (*qvclient.LocalTrack).
type soundTrack interface {
	WriteFrame(layer uint32, keyframe bool, captureUS uint64, payload []byte) error
	KeyframeRequests() <-chan uint32
	Unpublish() error
}

type soundChunk struct {
	pcm []float32
	us  int64
}

type screenSound struct {
	enc   *opus.Encoder
	in    chan soundChunk
	done  chan struct{}
	ended chan struct{}
	once  sync.Once
	track atomic.Pointer[soundTrack]
}

func newScreenSound() (*screenSound, error) {
	enc, err := opus.NewEncoder(media.AudioRate, 1, soundApp)
	if err != nil {
		return nil, err
	}
	if err := enc.SetBitrate(soundBitrate); err != nil {
		return nil, err
	}
	s := &screenSound{enc: enc, in: make(chan soundChunk, soundQueue), done: make(chan struct{}), ended: make(chan struct{})}
	go s.run()
	return s, nil
}

// capture is media.ScreenOptions.Audio: it runs on the capture thread, so
// it only copies the samples and hands them on (dropping if the encoder is
// that far behind).
func (s *screenSound) capture(pcm []float32, captureUS int64) {
	c := soundChunk{pcm: append([]float32(nil), pcm...), us: captureUS}
	select {
	case s.in <- c:
	default:
	}
}

// publish starts sending on a SCREEN_AUDIO track for the share's track.
func (s *screenSound) publish(ctx context.Context, c *qvclient.Client, screenTrack uint32) error {
	if c == nil {
		return errors.New("video: not connected")
	}
	t, err := c.Publish(ctx, controlpb.TrackKind_SCREEN_AUDIO, "opus",
		[]*controlpb.Layer{{Id: 0, Bitrate: soundBitrate}}, qvclient.PublishOptions{ForTrack: screenTrack})
	if err != nil {
		return err
	}
	s.use(t)
	return nil
}

func (s *screenSound) use(t soundTrack) { s.track.Store(&t) }

func (s *screenSound) stop() {
	s.once.Do(func() {
		close(s.done)
		<-s.ended
		if t := s.track.Load(); t != nil {
			_ = (*t).Unpublish()
		}
	})
}

func (s *screenSound) run() {
	defer close(s.ended)
	frame := make([]float32, 0, soundFrame)
	pkt := make([]byte, soundMaxPayload)
	var anchor, n int64 // the count's start (capture µs) and frames since
	key, inGroup := true, 0
	for {
		var c soundChunk
		select {
		case <-s.done:
			return
		case c = <-s.in:
		}
		next := anchor + n*soundFrameUS + int64(len(frame))*1_000_000/media.AudioRate
		if anchor == 0 || abs64(c.us-next) > soundResyncUS {
			frame, anchor, n, key = frame[:0], c.us, 0, true
		}
		for _, v := range c.pcm {
			frame = append(frame, v)
			if len(frame) < soundFrame {
				continue
			}
			us := anchor + n*soundFrameUS
			n++
			m, err := s.enc.EncodeFloat32(frame, pkt)
			frame = frame[:0]
			if err != nil {
				log.Printf("video: share sound: %v", err)
				continue
			}
			tp := s.track.Load()
			if tp == nil {
				continue // not published yet
			}
			t := *tp
			for drained := false; !drained; {
				select {
				case <-t.KeyframeRequests():
					key = true
				default:
					drained = true
				}
			}
			if inGroup >= soundGroup {
				key = true
			}
			if err := t.WriteFrame(0, key, uint64(us), append([]byte(nil), pkt[:m]...)); err != nil {
				key = true // nobody listening, or the queue dropped: start a group next
				continue
			}
			if key {
				inGroup = 0
			}
			key = false
			inGroup++
		}
	}
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
