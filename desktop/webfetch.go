package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"syscall"
	"time"
)

// webFetcher fetches public web pages for link previews and Spotify cards.
// Two guards against being pointed at the user's own network (SSRF): the
// hostname is checked before fetching (isBlockedHost), and every address it
// actually connects to — after DNS, and on every redirect — is checked too,
// so a public name resolving to a private address is refused.
type webFetcher struct {
	client  *http.Client
	hostMap map[string]string
}

// browserUA: many sites (Cloudflare et al.) answer non-browser user agents
// with a 403, so present as a mainstream desktop browser.
const browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

var errBlockedAddr = errors.New("blocked address")

// newWebFetcher: hostMap is the e2e-only BOSON_E2E_HOST_MAP
// ("name=1.2.3.4[,…]"), honoured in dev builds — a test /etc/hosts that lets
// a spec serve a page from a local server under a public-looking name.
func newWebFetcher(timeout time.Duration, allowHostMap bool) *webFetcher {
	f := &webFetcher{hostMap: map[string]string{}}
	if allowHostMap {
		for _, kv := range strings.Split(os.Getenv("BOSON_E2E_HOST_MAP"), ",") {
			name, ip, ok := strings.Cut(strings.TrimSpace(kv), "=")
			if ok && name != "" && ip != "" {
				f.hostMap[strings.ToLower(name)] = ip
			}
		}
	}
	dialer := &net.Dialer{Timeout: timeout}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		if ip, ok := f.hostMap[strings.ToLower(host)]; ok {
			return dialer.DialContext(ctx, network, net.JoinHostPort(ip, port))
		}
		d := *dialer
		d.Control = func(_, address string, _ syscall.RawConn) error {
			h, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			if ip := net.ParseIP(h); ip == nil || isBlockedIP(ip) {
				return errBlockedAddr
			}
			return nil
		}
		return d.DialContext(ctx, network, addr)
	}
	f.client = &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("too many redirects")
			}
			if isBlockedHost(req.URL.Hostname()) {
				return errBlockedAddr
			}
			return nil
		},
	}
	return f
}

// get fetches url as a browser would and reads at most limit bytes of the
// body. It returns the final URL (after redirects) and the content type.
func (f *webFetcher) get(ctx context.Context, url string, accept string, limit int64) (body []byte, finalURL, contentType string, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", "", err
	}
	req.Header.Set("User-Agent", browserUA)
	req.Header.Set("Accept", accept)
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	res, err := f.client.Do(req)
	if err != nil {
		return nil, "", "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, "", "", errors.New(res.Status)
	}
	body, err = io.ReadAll(io.LimitReader(res.Body, limit))
	return body, res.Request.URL.String(), res.Header.Get("Content-Type"), err
}

// isBlockedHost refuses loopback, private (RFC 1918), link-local and CGNAT
// hosts, and .local/.localhost names. A port of og-parse.ts.
func isBlockedHost(hostname string) bool {
	h := strings.Trim(strings.ToLower(hostname), "[]")
	if h == "localhost" || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".localhost") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return isBlockedIP(ip)
	}
	return false
}

func isBlockedIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		if v4[0] == 0 {
			return true
		}
		if v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 { // CGNAT
			return true
		}
	}
	return false
}
