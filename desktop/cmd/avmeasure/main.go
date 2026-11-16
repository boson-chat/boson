//go:build cgo && !server

// avmeasure measures lip sync end to end: how far apart a person's video
// and audio play in the boson app.
//
// A publisher joins a voice channel and its video room (with a ticket from
// voice) and, once a second, beeps (100 ms, 1 kHz, through the real
// quicvoice engine, which sends AudioClock reports) and sends a video
// frame stamped with the beep's capture time (the "flash"); ~30 fps of
// other frames in between. A receiver does what the app does:
//   - plays audio through the quicvoice engine on a simulated 10 ms device
//     and notes when each beep comes out;
//   - keeps an avsync.Clock from the publisher's AudioClock reports and,
//     every 200 ms, the offset from Engine.Playout, kept through silences
//     (VoiceService.avOffsets);
//   - shows each frame at capture time + offset in a 16 ms render loop
//     (the renderer's VideoController), or as it comes without an offset;
//   - with -adapt, delays the publisher's audio when video arrives late
//     (VideoService.adaptDelays: p90 lateness once a second, +10 ms margin,
//     eases 20 ms when > 50 ms early, ≤ 150 ms, 2 s to settle).
//
// Skew = when the flash shows − when the beep plays; ITU-R BT.1359 allows
// −125 ms (sound late) to +45 ms (sound early).
//
// Run against a local quicvoiced (1.11+, AUTH_INSECURE, VIDEO_QUIC_URL) and
// quicvideod (its JWKS from quicvoiced) on an otherwise idle machine (it
// paces audio in real time):
//
//	go run -tags nolibopusfile ./cmd/avmeasure -voice 127.0.0.1:7700 -n 15 -video-delay 100ms -adapt
package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"math"
	"net/url"
	"sort"
	"sync"
	"time"

	qv "github.com/boson-chat/quicvideo/client"
	vpb "github.com/boson-chat/quicvideo/gen/controlpb"
	"github.com/boson-chat/quicvoice/client"
	"github.com/boson-chat/quicvoice/client/avsync"
	"github.com/boson-chat/quicvoice/client/voice"
	"github.com/boson-chat/quicvoice/gen/controlpb"
)

var (
	voiceAddr  = flag.String("voice", "127.0.0.1:27800", "quicvoiced")
	beeps      = flag.Int("n", 20, "beeps")
	videoDelay = flag.Duration("video-delay", 0, "extra delay before sending each video frame (encode latency)")
	decodeMs   = flag.Float64("decode-ms", 5, "assumed decode time at the receiver (ms)")
	adapt      = flag.Bool("adapt", false, "delay the sender's audio when their video arrives after it (boson's rule)")
)

const chunk = 480 // 10 ms at 48 kHz

func main() {
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// ---- receiver (joins first so it sees everything) ----
	rx := newReceiver()
	rv, err := client.Dial(ctx, client.Config{Addr: *voiceAddr, Token: "watch", InsecureSkipVerify: true,
		OnAudio: rx.eng.HandleAudio, OnControl: rx.onVoiceControl})
	check(err)
	rstate, err := rv.Join(ctx, "general")
	check(err)
	_ = rstate
	go rx.device()

	// ---- publisher ----
	pe, err := voice.NewEngine(voice.Options{VADThreshold: 0.05})
	check(err)
	pv, err := client.Dial(ctx, client.Config{Addr: *voiceAddr, Token: "flash", InsecureSkipVerify: true})
	check(err)
	pst, err := pv.Join(ctx, "general")
	check(err)
	pe.SetSender(pv)
	rx.mu.Lock()
	rx.pubSID = uint16(pst.GetYourSessionId())
	rx.mu.Unlock()

	// Video for both, with tickets from voice.
	pvid := videoDial(ctx, pv, nil)
	rvid := videoDial(ctx, rv, rx.onFrame)
	track, err := pvid.Publish(ctx, vpb.TrackKind_CAMERA, "h264", []*vpb.Layer{{Id: 0, Width: 640, Height: 360, Fps: 30, Bitrate: 600_000}})
	check(err)
	go rx.watchVideo(rvid)

	// Publisher loop: 10 ms audio chunks in real time; a 100 ms beep every
	// second; video frames every ~33 ms, the flash frame stamped with the
	// beep's first sample's capture time.
	var phase float64
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	start := time.Now()
	next := start.Add(1500 * time.Millisecond)
	beepLeft := 0
	sent := 0
	lastVideo := time.Now()
	for sent < *beeps || beepLeft > 0 {
		<-tick.C
		now := time.Now()
		pcm := make([]int16, chunk)
		flash := int64(0)
		if beepLeft == 0 && now.After(next) && sent < *beeps {
			beepLeft = 10
			sent++
			next = next.Add(time.Second)
			// The chunk's last sample is captured "now" (Capture's rule):
			// its first sample 10 ms earlier.
			flash = now.UnixMicro() - int64(chunk)*1_000_000/48000
		}
		if beepLeft > 0 {
			for i := range pcm {
				pcm[i] = int16(0.5 * 32767 * math.Sin(phase))
				phase += 2 * math.Pi * 1000 / 48000
			}
			beepLeft--
		}
		capUS := now.UnixMicro()
		pe.Capture(pcm) // stamps the chunk with time.Now() ≈ capUS
		if flash != 0 {
			rx.expect(flash)
			sendFrame(track, uint64(flash), true)
			lastVideo = now
		} else if now.Sub(lastVideo) >= 33*time.Millisecond {
			sendFrame(track, uint64(capUS), false)
			lastVideo = now
		}
	}
	time.Sleep(2 * time.Second)
	rx.report()
}

func sendFrame(t *qv.LocalTrack, captureUS uint64, flash bool) {
	payload := []byte{0, 0, 0, 1, 0x65, 0x88, 0x84}
	if !flash {
		payload[4] = 0x41
	}
	go func() {
		if *videoDelay > 0 {
			time.Sleep(*videoDelay)
		}
		_ = t.WriteFrame(0, true, captureUS, payload)
	}()
}

func videoDial(ctx context.Context, vc *client.Client, onFrame func(qv.RemoteFrame)) *qv.Client {
	t, err := vc.VideoTicket(ctx)
	check(err)
	u, err := url.Parse(t.GetQuicUrl())
	check(err)
	c, err := qv.Dial(ctx, u.Host, qv.Options{Token: t.GetToken(), TLS: &tls.Config{InsecureSkipVerify: true}, OnFrame: onFrame})
	check(err)
	_, err = c.Join(ctx, t.GetRoom())
	check(err)
	return c
}

type receiver struct {
	eng    *voice.Engine
	mu     sync.Mutex
	clock  avsync.Clock
	pubSID uint16
	// per beep (by flash capture µs): when its audio played, when its
	// frame arrived, and the offset then.
	flashes []int64
	played  []int64 // local µs the beep onsets came out, in order
	shown   map[int64]int64
	arrive  map[int64]int64
	offset  map[int64]int64
	inBeep  bool
	// boson's pipeline: the offset sampled every 200 ms (VideoService
	// sync), kept through silences; frames waiting for their due time.
	lastOff   int64
	haveOff   bool
	pending   []int64 // flash capture µs waiting to show
	shownAt   map[int64]int64
	offAtShow map[int64]int64
	unsynced  int
	extra     time.Duration
	lates     []time.Duration
	changedAt time.Time
}

func newReceiver() *receiver {
	e, err := voice.NewEngine(voice.Options{})
	check(err)
	r := &receiver{eng: e, shown: map[int64]int64{}, arrive: map[int64]int64{}, offset: map[int64]int64{},
		shownAt: map[int64]int64{}, offAtShow: map[int64]int64{}}
	go r.syncLoop()
	go r.renderLoop()
	return r
}

func (r *receiver) onVoiceControl(m *controlpb.ControlMessage) {
	if c := m.GetAudioClock(); c != nil {
		r.mu.Lock()
		if uint16(c.GetSessionId()) == r.pubSID {
			r.clock.Report(c.GetTimestamp(), c.GetCaptureUs())
		}
		r.mu.Unlock()
	}
}

// device: a 10 ms playback callback; a beep's onset is when the output
// gets loud after silence. Its speaker time is the callback time + the
// engine's default output latency (one callback) + its position.
func (r *receiver) device() {
	t := time.NewTicker(10 * time.Millisecond)
	defer t.Stop()
	buf := make([]int16, chunk)
	for range t.C {
		cb := time.Now().UnixMicro()
		r.eng.Playback(buf)
		onset := -1
		for i, v := range buf {
			if v > 3000 || v < -3000 {
				onset = i
				break
			}
		}
		r.mu.Lock()
		if onset >= 0 && !r.inBeep {
			r.played = append(r.played, cb+10_000+int64(onset)*1_000_000/48000)
			r.inBeep = true
		} else if onset < 0 {
			r.inBeep = false
		}
		r.mu.Unlock()
	}
}

// syncLoop is VideoService.sendSync: every 200 ms, the offset if the
// sender's audio is playing; otherwise the last one stays. Once a second
// it also applies boson's adaptive audio delay (VideoService.adaptDelays):
// worst lateness late → +lateness+10 ms; > 50 ms early → −20 ms; ≤ 150 ms.
func (r *receiver) syncLoop() {
	t := time.NewTicker(200 * time.Millisecond)
	defer t.Stop()
	n := 0
	for range t.C {
		n++
		r.mu.Lock()
		if *adapt && n%5 == 0 && len(r.lates) > 0 && time.Since(r.changedAt) >= 2*time.Second {
			sort.Slice(r.lates, func(i, j int) bool { return r.lates[i] < r.lates[j] })
			p90 := r.lates[(len(r.lates)-1)*9/10]
			want := r.extra
			switch {
			case p90 > 0:
				want += p90 + 10*time.Millisecond
			case p90 < -50*time.Millisecond:
				want -= min(20*time.Millisecond, -p90-50*time.Millisecond)
			}
			want = min(max(want, 0), 150*time.Millisecond)
			r.lates = r.lates[:0]
			if want != r.extra {
				r.extra = want
				r.changedAt = time.Now()
				r.eng.SetPlayoutDelay(r.pubSID, want)
			}
		} else if *adapt && time.Since(r.changedAt) < 2*time.Second {
			r.lates = r.lates[:0] // measured before the change took effect
		}
		if ts, local, ok := r.eng.Playout(r.pubSID); ok {
			if w, ok := r.clock.WallUS(ts); ok {
				r.lastOff, r.haveOff = local-w, true
			}
		}
		r.mu.Unlock()
	}
}

// renderLoop is the renderer's animation frame (~16 ms): a waiting frame
// shows once capture + offset comes round (immediately without one).
func (r *receiver) renderLoop() {
	t := time.NewTicker(16 * time.Millisecond)
	defer t.Stop()
	for range t.C {
		now := time.Now().UnixMicro()
		r.mu.Lock()
		keep := r.pending[:0]
		for _, c := range r.pending {
			ready := r.arrive[c] + int64(*decodeMs*1000)
			if now < ready {
				keep = append(keep, c)
				continue
			}
			if !r.haveOff {
				r.shownAt[c] = now
				r.unsynced++
				continue
			}
			if now >= c+r.lastOff {
				r.shownAt[c] = now
				r.offAtShow[c] = r.lastOff
				continue
			}
			keep = append(keep, c)
		}
		r.pending = keep
		r.mu.Unlock()
	}
}

func (r *receiver) expect(flash int64) {
	r.mu.Lock()
	r.flashes = append(r.flashes, flash)
	r.mu.Unlock()
}

func (r *receiver) watchVideo(c *qv.Client) {
	subscribed := false
	for m := range c.Events() {
		if ta := m.GetTrackAdded(); ta != nil && !subscribed {
			_ = c.Subscribe(ta.GetTrack().GetTrackId(), 0, 0)
			subscribed = true
		}
		if st := m.GetRoomState(); st != nil {
			for _, t := range st.GetTracks() {
				if !subscribed {
					_ = c.Subscribe(t.GetTrackId(), 0, 0)
					subscribed = true
				}
			}
		}
	}
}

func (r *receiver) onFrame(f qv.RemoteFrame) {
	now := time.Now().UnixMicro()
	r.mu.Lock()
	defer r.mu.Unlock()
	c := int64(f.CaptureUS)
	if *adapt && r.haveOff {
		late := time.Duration(now+int64(*decodeMs*1000)-(c+r.lastOff)) * time.Microsecond
		r.lates = append(r.lates, late)
	}
	isFlash := false
	for _, x := range r.flashes {
		if x == c {
			isFlash = true
		}
	}
	if !isFlash {
		return
	}
	r.arrive[c] = now
	r.pending = append(r.pending, c)
}

func (r *receiver) report() {
	r.mu.Lock()
	defer r.mu.Unlock()
	var skews []float64
	for i, f := range r.flashes {
		if i >= len(r.played) {
			break
		}
		shown, ok := r.shownAt[f]
		if !ok {
			fmt.Printf("beep %d: frame never shown\n", i)
			continue
		}
		skews = append(skews, float64(shown-r.played[i])/1000)
	}
	if len(skews) == 0 {
		log.Fatal("no measurements")
	}
	all := append([]float64(nil), skews...)
	sort.Float64s(skews)
	var sum float64
	inWindow := 0
	for _, s := range skews {
		sum += s
		// ITU-R BT.1359 detectability: sound may lead the picture by 45 ms
		// or lag it by 125 ms; skew = picture − sound, so −125..+45.
		if s >= -125 && s <= 45 {
			inWindow++
		}
	}
	fmt.Printf("video delay %v: %d beeps (first %d shown unsynced, before any offset), skew (flash shown − beep played) ms: mean %.1f, median %.1f, min %.1f, max %.1f; in the BT.1359 window (−125..+45): %d/%d\n",
		*videoDelay, len(skews), r.unsynced, sum/float64(len(skews)), skews[len(skews)/2], skews[0], skews[len(skews)-1], inWindow, len(skews))
	fmt.Printf("per beep: %v (audio delay at the end: %v)\n", fmtList(all), r.extra)
}

func fmtList(v []float64) string {
	out := ""
	for _, x := range v {
		out += fmt.Sprintf("%.0f ", x)
	}
	return out
}

func check(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
