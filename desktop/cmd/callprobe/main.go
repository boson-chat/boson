//go:build cgo && !server

// callprobe joins a real call as a second participant and checks that
// someone's camera arrives as video: it joins the voice channel, gets a
// video ticket from voice, joins the video room, subscribes to the first
// camera that isn't its own (or -user's), decodes it with the platform's
// decoder, and checks the pictures: how many, how fast, how big, not
// blank, and moving.
//
// It's the far end of the Android real-call camera test
// (desktop/scripts/android-call-test.sh): the phone (an emulator) turns
// its camera on in the app, and this says whether anyone could see it.
//
// Local stack (quicvoiced with AUTH_INSECURE: any token is the user id):
//
//	go run -tags nolibopusfile ./cmd/callprobe -voice 127.0.0.1:27700 -insecure -token probe
//
// Production (a test account's voice token, see the script):
//
//	go run -tags nolibopusfile ./cmd/callprobe -voice voice.boson.chat:7700 -token "$VOICE_TOKEN" -room <id>
//
// It prints one JSON line and exits 0 when the camera passed, 1 when it
// didn't, 2 on setup errors.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/jpeg"
	"math"
	"net/url"
	"os"
	"sync"
	"time"

	qv "github.com/boson-chat/quicvideo/client"
	"github.com/boson-chat/quicvideo/client/media"
	vpb "github.com/boson-chat/quicvideo/gen/controlpb"
	"github.com/boson-chat/quicvoice/client"
)

var (
	voiceAddr = flag.String("voice", "127.0.0.1:27700", "quicvoiced host:port")
	token     = flag.String("token", "probe", "voice token (any name with AUTH_INSECURE)")
	room      = flag.String("room", "general", "voice channel id")
	insecure  = flag.Bool("insecure", false, "skip TLS verification (a local server's self-signed certificate)")
	videoAddr = flag.String("video", "", "dial quicvideod here instead of the ticket's address (the emulator's 10.0.2.2 is the host's loopback)")
	user      = flag.String("user", "", "watch this user id's camera (default: the first that isn't ours)")
	wait      = flag.Duration("wait", 90*time.Second, "how long to wait for a camera to appear")
	watch     = flag.Duration("for", 10*time.Second, "how long to watch it")
	minFPS    = flag.Float64("min-fps", 5, "the camera passes at this many decoded pictures a second or more")
	needMove  = flag.Bool("need-motion", false, "the picture must also change (the emulator's emulated camera scene is still; a webcam or virtualscene moves)")
	save      = flag.String("save", "", "write the last decoded picture here (JPEG)")
	publish   = flag.Bool("publish", false, "instead: publish a moving test-pattern camera for -for (to check the probe and the stack)")
)

type result struct {
	OK        bool    `json:"ok"`
	Reason    string  `json:"reason,omitempty"`
	User      string  `json:"user,omitempty"`
	TrackID   uint32  `json:"trackId,omitempty"`
	Layers    string  `json:"layers,omitempty"`
	Received  int     `json:"received"`
	Decoded   int     `json:"decoded"`
	FPS       float64 `json:"fps"`
	Width     int     `json:"width"`
	Height    int     `json:"height"`
	Contrast  float64 `json:"contrast"` // luma std dev of the last picture (0 = flat)
	Motion    float64 `json:"motion"`   // mean luma change between pictures 1 s apart
	LatencyMs float64 `json:"latencyMs"`
}

func main() {
	flag.Parse()
	res := run()
	b, _ := json.Marshal(res)
	fmt.Println(string(b))
	switch {
	case res.OK:
		os.Exit(0)
	case res.Received == 0 && res.TrackID == 0:
		os.Exit(2)
	default:
		os.Exit(1)
	}
}

func run() result {
	ctx, cancel := context.WithTimeout(context.Background(), *wait+*watch+30*time.Second)
	defer cancel()
	vc, err := client.Dial(ctx, client.Config{Addr: *voiceAddr, Token: *token, InsecureSkipVerify: *insecure})
	if err != nil {
		return result{Reason: "voice: " + err.Error()}
	}
	defer vc.Close()
	if _, err := vc.Join(ctx, *room); err != nil {
		return result{Reason: "voice join: " + err.Error()}
	}
	t, err := vc.VideoTicket(ctx)
	if err != nil {
		return result{Reason: "video ticket: " + err.Error()}
	}
	addr := *videoAddr
	if addr == "" {
		u, err := url.Parse(t.GetQuicUrl())
		if err != nil {
			return result{Reason: "ticket url: " + err.Error()}
		}
		addr = u.Host
	}
	p := newProbe()
	c, err := qv.Dial(ctx, addr, qv.Options{Token: t.GetToken(), ClientVersion: "callprobe",
		TLS: &tls.Config{InsecureSkipVerify: *insecure}, OnFrame: p.onFrame})
	if err != nil {
		return result{Reason: "video: " + err.Error()}
	}
	defer c.Close()
	state, err := c.Join(ctx, t.GetRoom())
	if err != nil {
		return result{Reason: "video join: " + err.Error()}
	}
	if *publish {
		return publishPattern(ctx, c)
	}
	self := state.GetYourSessionId()
	people := map[uint32]string{}
	for _, pp := range state.GetParticipants() {
		people[pp.GetSessionId()] = pp.GetUserId()
	}
	pick := func(tr *vpb.Track) bool {
		return tr.GetKind() == vpb.TrackKind_CAMERA && tr.GetSessionId() != self && (*user == "" || people[tr.GetSessionId()] == *user)
	}
	var cam *vpb.Track
	// The newest camera: an earlier session of the same phone may still be
	// timing out with its old one.
	for _, tr := range state.GetTracks() {
		if pick(tr) && (cam == nil || tr.GetTrackId() > cam.GetTrackId()) {
			cam = tr
		}
	}
	deadline := time.After(*wait)
	for cam == nil {
		select {
		case m := <-c.Events():
			if j := m.GetParticipantJoined(); j != nil {
				people[j.GetParticipant().GetSessionId()] = j.GetParticipant().GetUserId()
			}
			if tr := m.GetTrackAdded().GetTrack(); tr != nil && pick(tr) {
				cam = tr
			}
		case <-deadline:
			return result{Reason: fmt.Sprintf("no camera in the call after %v", *wait)}
		case <-ctx.Done():
			return result{Reason: ctx.Err().Error()}
		}
	}
	res := result{User: people[cam.GetSessionId()], TrackID: cam.GetTrackId()}
	top := uint32(0)
	for _, l := range cam.GetLayers() {
		res.Layers += fmt.Sprintf("%d:%dx%d@%d ", l.GetId(), l.GetWidth(), l.GetHeight(), l.GetFps())
		top = max(top, l.GetId())
	}
	if err := p.start(cam.GetTrackId()); err != nil {
		res.Reason = "decoder: " + err.Error()
		return res
	}
	defer p.stop()
	if err := c.Subscribe(cam.GetTrackId(), top, 0); err != nil {
		res.Reason = "subscribe: " + err.Error()
		return res
	}
	// Give it a second to start (a keyframe), then watch.
	time.Sleep(time.Second)
	p.reset()
	time.Sleep(*watch)
	res = p.verdict(res)
	if *save != "" {
		p.mu.Lock()
		img := p.last
		p.mu.Unlock()
		if img != nil {
			if f, err := os.Create(*save); err == nil {
				_ = jpeg.Encode(f, img, &jpeg.Options{Quality: 85})
				f.Close()
			}
		}
	}
	return res
}

type probe struct {
	mu       sync.Mutex
	track    uint32
	dec      media.VideoDecoder
	received int
	decoded  int
	start0   time.Time
	w, h     int
	contrast float64
	lumas    [][]float64 // a small luma grid per second
	lastGrid time.Time
	lat      []float64
	last     *image.RGBA
}

func newProbe() *probe { return &probe{} }

func (p *probe) start(track uint32) error {
	dec, err := media.NewVideoDecoder(p.onPicture)
	if err != nil {
		return err
	}
	p.mu.Lock()
	p.track, p.dec = track, dec
	p.mu.Unlock()
	return nil
}

func (p *probe) stop() {
	p.mu.Lock()
	d := p.dec
	p.dec = nil
	p.mu.Unlock()
	if d != nil {
		d.Close()
	}
}

func (p *probe) reset() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.received, p.decoded, p.start0 = 0, 0, time.Now()
	p.lumas, p.lat = nil, nil
}

func (p *probe) onFrame(f qv.RemoteFrame) {
	p.mu.Lock()
	d := p.dec
	ok := d != nil && f.TrackID == p.track
	if ok {
		p.received++
		p.lat = append(p.lat, float64(time.Now().UnixMicro()-int64(f.CaptureUS))/1000)
	}
	p.mu.Unlock()
	if ok {
		_ = d.Decode(f.Payload, f.CaptureUS)
	}
}

func (p *probe) onPicture(pic media.Picture, _ uint64) {
	img, err := media.ToRGBA(pic, 160)
	if err != nil {
		return
	}
	w, h := pic.Size()
	grid, contrast := lumaGrid(img)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.decoded++
	p.w, p.h, p.contrast = w, h, contrast
	p.last = img
	if time.Since(p.lastGrid) >= time.Second {
		p.lastGrid = time.Now()
		p.lumas = append(p.lumas, grid)
	}
}

// lumaGrid is the picture's mean luma in 8×8 cells, and its std dev.
func lumaGrid(img *image.RGBA) ([]float64, float64) {
	b := img.Bounds()
	grid := make([]float64, 64)
	counts := make([]float64, 64)
	var sum, sq, n float64
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			o := img.PixOffset(x, y)
			l := 0.299*float64(img.Pix[o]) + 0.587*float64(img.Pix[o+1]) + 0.114*float64(img.Pix[o+2])
			cell := (y-b.Min.Y)*8/b.Dy()*8 + (x-b.Min.X)*8/b.Dx()
			grid[cell] += l
			counts[cell]++
			sum += l
			sq += l * l
			n++
		}
	}
	for i := range grid {
		if counts[i] > 0 {
			grid[i] /= counts[i]
		}
	}
	mean := sum / n
	return grid, math.Sqrt(max(sq/n-mean*mean, 0))
}

func (p *probe) verdict(res result) result {
	p.mu.Lock()
	defer p.mu.Unlock()
	secs := time.Since(p.start0).Seconds()
	res.Received, res.Decoded = p.received, p.decoded
	res.FPS = math.Round(float64(p.decoded)/secs*10) / 10
	res.Width, res.Height = p.w, p.h
	res.Contrast = math.Round(p.contrast*10) / 10
	var moved, pairs float64
	for i := 1; i < len(p.lumas); i++ {
		for j := range p.lumas[i] {
			moved += math.Abs(p.lumas[i][j] - p.lumas[i-1][j])
		}
		pairs += float64(len(p.lumas[i]))
	}
	if pairs > 0 {
		res.Motion = math.Round(moved/pairs*10) / 10
	}
	if len(p.lat) > 0 {
		var s float64
		for _, l := range p.lat {
			s += l
		}
		res.LatencyMs = math.Round(s / float64(len(p.lat)))
	}
	switch {
	case p.decoded == 0:
		res.Reason = fmt.Sprintf("no picture decoded (%d frames received)", p.received)
	case res.FPS < *minFPS:
		res.Reason = fmt.Sprintf("%.1f fps, want %.0f or more", res.FPS, *minFPS)
	case res.Contrast < 4:
		res.Reason = "the picture is blank (flat)"
	case *needMove && res.Motion < 0.5:
		res.Reason = "the picture isn't moving"
	default:
		res.OK = true
	}
	return res
}

// publishPattern sends a moving test pattern as a camera, through the
// platform's encoder, for -for.
func publishPattern(ctx context.Context, c *qv.Client) result {
	layers := media.CameraLayers(1280, 720, 30)
	pub, _, err := media.PublishTrack(ctx, c, vpb.TrackKind_CAMERA, layers, media.DefaultEncoder, media.PublisherOptions{})
	if err != nil {
		return result{Reason: "publish: " + err.Error()}
	}
	defer pub.Close()
	src, err := media.NewPatternSource(1280, 720, 30, pub.Push)
	if err != nil {
		return result{Reason: "pattern: " + err.Error()}
	}
	time.Sleep(*watch)
	src.Stop()
	return result{OK: true, Reason: "published"}
}
