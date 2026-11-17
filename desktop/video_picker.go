package main

import (
	"encoding/base64"
	"sync"
	"time"
)

// The screen share picker's live thumbnails: while the picker is open the
// page polls ScreenThumbnails with the sources it shows; their pictures are
// refreshed about twice a second, a few at a time. The capture stops as
// soon as the page says so (StopThumbnails, when the picker closes) or, if
// it never does, thumbnailIdle after its last poll.

const (
	thumbnailWidth   = 320
	thumbnailEvery   = 500 * time.Millisecond
	thumbnailIdle    = 3 * time.Second
	thumbnailWorkers = 4
)

type thumbSession struct {
	mu     sync.Mutex
	ids    []string
	images map[string]string // id → data: URL
	polled time.Time
	stop   chan struct{}
	once   sync.Once
}

func (t *thumbSession) close() { t.once.Do(func() { close(t.stop) }) }

// ScreenThumbnails returns the latest thumbnails (data: URLs) of these
// sources, and keeps them coming for as long as the page keeps asking.
func (v *VideoService) ScreenThumbnails(ids []string) map[string]string {
	if v.media == nil {
		return map[string]string{}
	}
	v.thumbMu.Lock()
	t := v.thumbs
	if t == nil {
		t = &thumbSession{images: map[string]string{}, stop: make(chan struct{})}
		v.thumbs = t
		go v.runThumbnails(t)
	}
	v.thumbMu.Unlock()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.ids = append([]string(nil), ids...)
	t.polled = v.now()
	out := make(map[string]string, len(ids))
	for _, id := range ids {
		if img, ok := t.images[id]; ok {
			out[id] = img
		}
	}
	return out
}

// StopThumbnails ends the thumbnail capture (the picker closed).
func (v *VideoService) StopThumbnails() {
	v.thumbMu.Lock()
	t := v.thumbs
	v.thumbs = nil
	v.thumbMu.Unlock()
	if t != nil {
		t.close()
	}
}

// thumbnailsRunning: a capture session is running (tests).
func (v *VideoService) thumbnailsRunning() bool {
	v.thumbMu.Lock()
	defer v.thumbMu.Unlock()
	return v.thumbs != nil
}

func (v *VideoService) runThumbnails(t *thumbSession) {
	defer func() {
		v.thumbMu.Lock()
		if v.thumbs == t {
			v.thumbs = nil
		}
		newer := v.thumbs != nil // the picker reopened meanwhile
		v.thumbMu.Unlock()
		// The media's own thumbnail captures (Windows keeps one running per
		// source between pictures) stop with the session.
		if s, ok := v.media.(thumbStopper); ok && !newer {
			s.StopThumbnails()
		}
	}()
	tick := time.NewTicker(thumbnailEvery)
	defer tick.Stop()
	for {
		t.mu.Lock()
		ids := append([]string(nil), t.ids...)
		idle := v.now().Sub(t.polled) > thumbnailIdle
		t.mu.Unlock()
		if idle {
			t.close()
			return
		}
		v.captureThumbnails(t, ids)
		select {
		case <-t.stop:
			return
		case <-tick.C:
		}
	}
}

func (v *VideoService) captureThumbnails(t *thumbSession, ids []string) {
	work := make(chan string)
	var wg sync.WaitGroup
	for range min(thumbnailWorkers, len(ids)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for id := range work {
				b, err := v.media.Thumbnail(id, thumbnailWidth)
				if err != nil || len(b) == 0 {
					continue
				}
				url := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(b)
				t.mu.Lock()
				t.images[id] = url
				t.mu.Unlock()
			}
		}()
	}
	for _, id := range ids {
		select {
		case work <- id:
		case <-t.stop:
		}
	}
	close(work)
	wg.Wait()
}

// thumbStopper is media whose thumbnails keep captures running between
// pictures (Windows: Windows.Graphics.Capture has no one-shot screenshot).
type thumbStopper interface{ StopThumbnails() }
