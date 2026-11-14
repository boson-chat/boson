package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	_ "image/gif"  // DecodeConfig: GIF dimensions
	_ "image/jpeg" // DecodeConfig: JPEG dimensions
	_ "image/png"  // DecodeConfig: PNG dimensions
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"
)

// BrandingService fetches network branding (boson-theme/1 documents and
// their images) for the renderer. The page's CSP doesn't let it reach
// arbitrary origins, and a network's branding lives on that network's own
// host, so the shell fetches it: https only (http to loopback in dev builds),
// never a private address (checked on every connection, so a public name
// resolving to a LAN address is refused too), small documents, and images
// that are really images of a sane size. The renderer turns image bytes into
// blob: URLs.
type BrandingService struct {
	client  *http.Client
	dev     bool
	hostMap map[string]string
}

const (
	brandingDocMax       = 16 * 1024       // boson-theme/1: the whole document
	brandingImageMax     = 2 * 1024 * 1024 // per image
	brandingImageMaxSide = 4096
	brandingTimeout      = 8 * time.Second
	brandingMaxRedirects = 3
)

// BrandingDoc is Fetch's answer. Status is the HTTP status (304 when the
// ETag still matches, 0 when nothing answered); Body is the document on 200.
type BrandingDoc struct {
	Status int    `json:"status"`
	ETag   string `json:"etag,omitempty"`
	Body   string `json:"body,omitempty"`
	Error  string `json:"error,omitempty"`
}

// BrandingImage is Image's answer: the sniffed type and the bytes (base64),
// or why the image was refused.
type BrandingImage struct {
	ContentType string `json:"contentType,omitempty"`
	Data        string `json:"data,omitempty"`
	Error       string `json:"error,omitempty"`
}

// BrandingPolicy tells the renderer which image URLs the shell will fetch,
// so it validates theme documents the same way.
type BrandingPolicy struct {
	AllowLoopbackHTTP bool `json:"allowLoopbackHttp"`
}

func NewBrandingService(dev bool) *BrandingService {
	s := &BrandingService{dev: dev, hostMap: map[string]string{}}
	if dev {
		// BOSON_E2E_HOST_MAP (see webfetch.go): a public-looking name served
		// from a local test server.
		for _, kv := range strings.Split(os.Getenv("BOSON_E2E_HOST_MAP"), ",") {
			name, ip, ok := strings.Cut(strings.TrimSpace(kv), "=")
			if ok && name != "" && ip != "" {
				s.hostMap[strings.ToLower(name)] = ip
			}
		}
	}
	dialer := &net.Dialer{Timeout: brandingTimeout}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		if ip, ok := s.hostMap[strings.ToLower(host)]; ok {
			return dialer.DialContext(ctx, network, net.JoinHostPort(ip, port))
		}
		d := *dialer
		d.Control = func(_, address string, _ syscall.RawConn) error {
			h, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			ip := net.ParseIP(h)
			if ip == nil {
				return errBlockedAddr
			}
			if s.dev && ip.IsLoopback() {
				return nil
			}
			if isBlockedIP(ip) {
				return errBlockedAddr
			}
			return nil
		}
		return d.DialContext(ctx, network, addr)
	}
	s.client = &http.Client{
		Timeout:   brandingTimeout,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= brandingMaxRedirects {
				return errors.New("too many redirects")
			}
			if err := s.checkURL(req.URL); err != nil {
				return err
			}
			return nil
		},
	}
	return s
}

// Policy is what the renderer needs to validate image URLs like the shell.
func (s *BrandingService) Policy() BrandingPolicy {
	return BrandingPolicy{AllowLoopbackHTTP: s.dev}
}

// checkURL: https to a public host, or (dev builds) http/https to loopback
// or a host-mapped name. No credentials.
func (s *BrandingService) checkURL(u *url.URL) error {
	if u == nil || u.Host == "" || u.User != nil {
		return errors.New("not an absolute URL")
	}
	host := strings.ToLower(u.Hostname())
	_, mapped := s.hostMap[host]
	loop := isLoopback(u)
	switch u.Scheme {
	case "https":
	case "http":
		if !(s.dev && (loop || mapped)) {
			return errors.New("https only")
		}
	default:
		return errors.New("https only")
	}
	if mapped || (s.dev && loop) {
		return nil
	}
	if isBlockedHost(host) {
		return errBlockedAddr
	}
	return nil
}

func (s *BrandingService) parse(raw string) (*url.URL, error) {
	if len(raw) > 2048 {
		return nil, errors.New("url too long")
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, errors.New("bad url")
	}
	if err := s.checkURL(u); err != nil {
		return nil, err
	}
	u.Fragment = ""
	return u, nil
}

func (s *BrandingService) do(ctx context.Context, u *url.URL, accept, etag string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", "Boson")
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	return s.client.Do(req)
}

// Fetch reads a boson-theme/1 document (validated by the renderer), with
// If-None-Match when etag is set.
func (s *BrandingService) Fetch(ctx context.Context, rawURL, etag string) BrandingDoc {
	u, err := s.parse(rawURL)
	if err != nil {
		return BrandingDoc{Error: err.Error()}
	}
	ctx, cancel := context.WithTimeout(ctx, brandingTimeout)
	defer cancel()
	res, err := s.do(ctx, u, "application/json", etag)
	if err != nil {
		return BrandingDoc{Error: err.Error()}
	}
	defer res.Body.Close()
	out := BrandingDoc{Status: res.StatusCode, ETag: res.Header.Get("ETag")}
	if res.StatusCode != http.StatusOK {
		return out
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, brandingDocMax+1))
	if err != nil {
		return BrandingDoc{Status: res.StatusCode, Error: err.Error()}
	}
	if len(body) > brandingDocMax {
		return BrandingDoc{Status: res.StatusCode, Error: "document too large"}
	}
	out.Body = string(body)
	return out
}

// Image fetches one branding image: png, jpeg, webp, gif or svg (by its
// bytes, not its Content-Type), at most 2 MB and 4096 px a side.
func (s *BrandingService) Image(ctx context.Context, rawURL string) BrandingImage {
	u, err := s.parse(rawURL)
	if err != nil {
		return BrandingImage{Error: err.Error()}
	}
	ctx, cancel := context.WithTimeout(ctx, brandingTimeout)
	defer cancel()
	res, err := s.do(ctx, u, "image/png,image/jpeg,image/webp,image/gif,image/svg+xml", "")
	if err != nil {
		return BrandingImage{Error: err.Error()}
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return BrandingImage{Error: res.Status}
	}
	if res.ContentLength > brandingImageMax {
		return BrandingImage{Error: "image too large"}
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, brandingImageMax+1))
	if err != nil {
		return BrandingImage{Error: err.Error()}
	}
	if len(body) > brandingImageMax {
		return BrandingImage{Error: "image too large"}
	}
	ct, err := checkBrandingImage(body)
	if err != nil {
		return BrandingImage{Error: err.Error()}
	}
	return BrandingImage{ContentType: ct, Data: base64.StdEncoding.EncodeToString(body)}
}

// checkBrandingImage sniffs body's type and checks its dimensions.
func checkBrandingImage(body []byte) (string, error) {
	if len(body) == 0 {
		return "", errors.New("empty image")
	}
	ct := http.DetectContentType(body)
	switch ct {
	case "image/png", "image/jpeg", "image/gif":
		cfg, _, err := image.DecodeConfig(bytes.NewReader(body))
		if err != nil {
			return "", fmt.Errorf("unreadable %s", ct)
		}
		if err := checkSides(cfg.Width, cfg.Height); err != nil {
			return "", err
		}
		return ct, nil
	case "image/webp":
		w, h, err := webpSize(body)
		if err != nil {
			return "", err
		}
		if err := checkSides(w, h); err != nil {
			return "", err
		}
		return ct, nil
	}
	if isSVG(body) {
		// Only ever shown as an image (blob: URL in <img>/CSS), where it
		// can't run scripts or load anything.
		return "image/svg+xml", nil
	}
	return "", fmt.Errorf("not a supported image (%s)", ct)
}

func checkSides(w, h int) error {
	if w <= 0 || h <= 0 {
		return errors.New("image has no size")
	}
	if w > brandingImageMaxSide || h > brandingImageMaxSide {
		return fmt.Errorf("image is %dx%d (max %d a side)", w, h, brandingImageMaxSide)
	}
	return nil
}

// isSVG: an XML document whose root element is <svg>.
func isSVG(body []byte) bool {
	b := bytes.TrimSpace(bytes.TrimPrefix(body, []byte("\xef\xbb\xbf")))
	// Skip the prolog: <?xml …?>, comments and a doctype.
	for len(b) > 0 {
		switch {
		case bytes.HasPrefix(b, []byte("<?")):
			i := bytes.Index(b, []byte("?>"))
			if i < 0 {
				return false
			}
			b = bytes.TrimSpace(b[i+2:])
		case bytes.HasPrefix(b, []byte("<!--")):
			i := bytes.Index(b, []byte("-->"))
			if i < 0 {
				return false
			}
			b = bytes.TrimSpace(b[i+3:])
		case bytes.HasPrefix(b, []byte("<!")):
			i := bytes.IndexByte(b, '>')
			if i < 0 {
				return false
			}
			b = bytes.TrimSpace(b[i+1:])
		default:
			if !bytes.HasPrefix(b, []byte("<svg")) || len(b) < 5 {
				return false
			}
			c := b[4]
			return c == ' ' || c == '>' || c == '\n' || c == '\t' || c == '\r' || c == '/'
		}
	}
	return false
}

// webpSize reads a WebP's canvas size from its first chunk (VP8, VP8L or
// VP8X) without decoding it.
func webpSize(b []byte) (int, int, error) {
	bad := errors.New("unreadable image/webp")
	if len(b) < 30 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WEBP" {
		return 0, 0, bad
	}
	chunk := string(b[12:16])
	data := b[20:]
	switch chunk {
	case "VP8 ":
		// Frame tag (3 bytes), start code 9d 01 2a, then 14-bit sizes.
		if len(data) < 10 || data[3] != 0x9d || data[4] != 0x01 || data[5] != 0x2a {
			return 0, 0, bad
		}
		w := int(binary.LittleEndian.Uint16(data[6:8]) & 0x3fff)
		h := int(binary.LittleEndian.Uint16(data[8:10]) & 0x3fff)
		return w, h, nil
	case "VP8L":
		if len(data) < 5 || data[0] != 0x2f {
			return 0, 0, bad
		}
		bits := binary.LittleEndian.Uint32(data[1:5])
		return int(bits&0x3fff) + 1, int((bits>>14)&0x3fff) + 1, nil
	case "VP8X":
		if len(data) < 10 {
			return 0, 0, bad
		}
		w := int(data[4]) | int(data[5])<<8 | int(data[6])<<16
		h := int(data[7]) | int(data[8])<<8 | int(data[9])<<16
		return w + 1, h + 1, nil
	}
	return 0, 0, bad
}
