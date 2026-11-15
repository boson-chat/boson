package selfupdate

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// DefaultFeed is GitHub's latest-release API for the app's repository. A
// feed is any URL that answers with that JSON shape (tag_name, body,
// html_url, assets[].name/size/browser_download_url): dev builds point the
// updater at a local one (BOSON_UPDATE_FEED) for end-to-end runs.
const DefaultFeed = "https://api.github.com/repos/boson-chat/boson/releases/latest"

// Release is a feed's latest release.
type Release struct {
	Version string
	// Notes: the release body (markdown, as semantic-release writes it).
	Notes   string
	PageURL string
	Assets  map[string]ReleaseAsset
}

// ReleaseAsset is one downloadable file of a release.
type ReleaseAsset struct {
	Name string
	URL  string
	Size int64
}

var (
	// ErrNoManifest: the release has no signed manifest (a build without
	// the signing key); the app can only point at the release page.
	ErrNoManifest = errors.New("selfupdate: the release has no update manifest")
	ErrSize       = errors.New("selfupdate: the download's size doesn't match the manifest")
	ErrChecksum   = errors.New("selfupdate: the download's sha256 doesn't match the manifest")
)

// FetchRelease reads the feed's latest release.
func FetchRelease(ctx context.Context, client *http.Client, feed string) (*Release, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	body, err := get(ctx, client, feed, 4<<20, "application/vnd.github+json")
	if err != nil {
		return nil, err
	}
	var r struct {
		TagName string `json:"tag_name"`
		Body    string `json:"body"`
		HTMLURL string `json:"html_url"`
		Assets  []struct {
			Name string `json:"name"`
			Size int64  `json:"size"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, fmt.Errorf("selfupdate: feed: %w", err)
	}
	rel := &Release{
		Version: strings.TrimPrefix(r.TagName, "v"),
		Notes:   r.Body,
		PageURL: r.HTMLURL,
		Assets:  map[string]ReleaseAsset{},
	}
	for _, a := range r.Assets {
		rel.Assets[a.Name] = ReleaseAsset{Name: a.Name, URL: a.URL, Size: a.Size}
	}
	return rel, nil
}

// Manifest downloads and verifies the release's manifest. ErrNoManifest when
// it has none; a manifest without a (valid) signature is ErrUnsigned or
// ErrBadSignature, never a usable manifest.
func (r *Release) Manifest(ctx context.Context, client *http.Client, keys []ed25519.PublicKey) (*Manifest, error) {
	ma, ok := r.Assets[ManifestAsset]
	if !ok {
		return nil, ErrNoManifest
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	manifest, err := get(ctx, client, ma.URL, MaxManifestSize, "")
	if err != nil {
		return nil, err
	}
	sa, ok := r.Assets[SignatureAsset]
	if !ok {
		return nil, ErrUnsigned
	}
	sig, err := get(ctx, client, sa.URL, 4<<10, "")
	if err != nil {
		return nil, err
	}
	return VerifyManifest(manifest, sig, keys)
}

func get(ctx context.Context, client *http.Client, url string, limit int64, accept string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("selfupdate: GET %s: %s", url, res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("selfupdate: GET %s: response too large", url)
	}
	return b, nil
}

// Download fetches url to dst, reporting progress (bytes so far, of
// want.Size), and keeps it only if it is exactly want: the size (no more is
// read; a short download is ErrSize) and then the sha256 (ErrChecksum).
func Download(ctx context.Context, client *http.Client, url, dst string, want Asset, progress func(done, total int64)) error {
	sum, err := hex.DecodeString(want.SHA256)
	if err != nil || len(sum) != sha256.Size || want.Size <= 0 {
		return ErrBadManifest
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("selfupdate: GET %s: %s", url, res.Status)
	}
	part := dst + ".part"
	f, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			f.Close()
			os.Remove(part)
		}
	}()
	h := sha256.New()
	pw := &progressWriter{total: want.Size, fn: progress}
	// One byte past the size: a longer download is caught, not truncated
	// into a match.
	n, err := io.Copy(io.MultiWriter(f, h, pw), io.LimitReader(res.Body, want.Size+1))
	if err != nil {
		return err
	}
	if n != want.Size {
		return ErrSize
	}
	if !equalBytes(h.Sum(nil), sum) {
		return ErrChecksum
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(part, dst); err != nil {
		return err
	}
	ok = true
	return nil
}

// VerifyFile checks a file already on disk against want (size, sha256).
func VerifyFile(path string, want Asset) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, want.Size+1))
	if err != nil {
		return err
	}
	if n != want.Size {
		return ErrSize
	}
	sum, err := hex.DecodeString(want.SHA256)
	if err != nil || !equalBytes(h.Sum(nil), sum) {
		return ErrChecksum
	}
	return nil
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var d byte
	for i := range a {
		d |= a[i] ^ b[i]
	}
	return d == 0
}

type progressWriter struct {
	done, total int64
	fn          func(done, total int64)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	p.done += int64(len(b))
	if p.fn != nil {
		p.fn(min(p.done, p.total), p.total)
	}
	return len(b), nil
}
