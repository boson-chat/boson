package avatar

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/png"
	"strings"

	_ "image/gif"  // register GIF decoder
	_ "image/jpeg" // register JPEG decoder

	"github.com/google/uuid"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // register WebP decoder
)

const (
	// MaxUploadBytes caps the raw upload before we attempt to decode it.
	MaxUploadBytes = 5 << 20 // 5 MiB
	// avatarSize is the square edge every avatar is normalized to.
	avatarSize = 256
	// MaxImagePixels caps the DECODED dimensions. A small compressed file
	// can declare enormous dimensions (a decompression bomb) — e.g. a few-
	// KiB PNG claiming 30000×30000 decodes to gigabytes of pixels and OOMs
	// the process. We reject on DecodeConfig (which only reads the header)
	// before ever allocating the pixel buffer. 24MP comfortably covers any
	// legitimate avatar/banner source while capping a decode at ~96 MiB.
	MaxImagePixels = 24 * 1000 * 1000
)

var (
	ErrNotConfigured    = errors.New("avatar storage not configured")
	ErrTooLarge         = errors.New("image too large")
	ErrUnsupportedImage = errors.New("unsupported or invalid image")
)

type ServiceImpl interface {
	// Configured reports whether R2 is wired up; handlers 503 when false.
	Configured() bool
	// Process validates + normalizes a user avatar (square 256²) and uploads
	// it. Thin wrapper over ProcessImage. Best-effort deletes prevKey.
	Process(ctx context.Context, userID uuid.UUID, raw []byte, prevKey string) (key string, err error)
	// ProcessImage is the general pipeline: decode → cover-crop to width×height
	// → re-encode PNG → upload under `<namespace>/<id>-<hash>.png` (content-
	// addressed, immutable). Used for server icons/banners as well as avatars.
	ProcessImage(ctx context.Context, namespace, id string, raw []byte, prevKey string, width, height int) (key string, err error)
	// Remove best-effort deletes the object at key.
	Remove(ctx context.Context, key string) error
	// URLFor builds the public CDN URL for a stored key (empty in → empty out).
	URLFor(key string) string
}

type Service struct {
	storage    Storage
	cdnBaseURL string
}

func NewService(storage Storage, cdnBaseURL string) *Service {
	return &Service{storage: storage, cdnBaseURL: strings.TrimRight(cdnBaseURL, "/")}
}

func (s *Service) Configured() bool { return s != nil && s.storage != nil }

func (s *Service) URLFor(key string) string {
	if key == "" || s.cdnBaseURL == "" {
		return ""
	}
	return s.cdnBaseURL + "/" + key
}

func (s *Service) Process(ctx context.Context, userID uuid.UUID, raw []byte, prevKey string) (string, error) {
	return s.ProcessImage(ctx, "avatars", userID.String(), raw, prevKey, avatarSize, avatarSize)
}

func (s *Service) ProcessImage(ctx context.Context, namespace, id string, raw []byte, prevKey string, width, height int) (string, error) {
	if !s.Configured() {
		return "", ErrNotConfigured
	}
	if len(raw) == 0 {
		return "", ErrUnsupportedImage
	}
	if len(raw) > MaxUploadBytes {
		return "", ErrTooLarge
	}
	// Reject decompression bombs before decoding: DecodeConfig reads only
	// the header, so we learn the declared dimensions without allocating
	// the pixel buffer. A tiny file declaring huge dimensions is refused
	// here instead of OOM-ing the process inside image.Decode.
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrUnsupportedImage, err)
	}
	// Compare via division so a header declaring dimensions near the int
	// range can't overflow the multiplication and wrap past the cap.
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > MaxImagePixels/cfg.Height {
		return "", ErrTooLarge
	}
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrUnsupportedImage, err)
	}

	out := normalizeCover(src, width, height)
	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&buf, out); err != nil {
		return "", err
	}
	data := buf.Bytes()

	// Content-addressed key → each distinct image is a new, immutable URL,
	// so the CDN can cache forever and a change is picked up immediately.
	sum := sha256.Sum256(data)
	key := fmt.Sprintf("%s/%s-%s.png", namespace, id, hex.EncodeToString(sum[:6]))

	if err := s.storage.Put(ctx, key, data, "image/png"); err != nil {
		return "", err
	}
	if prevKey != "" && prevKey != key {
		_ = s.storage.Delete(ctx, prevKey) // best-effort; orphan is harmless
	}
	return key, nil
}

func (s *Service) Remove(ctx context.Context, key string) error {
	if !s.Configured() || key == "" {
		return nil
	}
	return s.storage.Delete(ctx, key)
}

// normalizeCover center-crops src to the target aspect ratio then high-quality
// scales it to width×height ("cover" fit), so every stored image is a uniform
// size regardless of the source dimensions. width == height gives a square
// (avatars, server icons); a wide target gives a banner.
func normalizeCover(src image.Image, width, height int) image.Image {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	if sw <= 0 || sh <= 0 {
		return image.NewRGBA(image.Rect(0, 0, width, height))
	}
	targetAR := float64(width) / float64(height)
	srcAR := float64(sw) / float64(sh)

	cw, ch := sw, sh
	if srcAR > targetAR {
		// Source is wider than target → crop the sides.
		cw = int(float64(sh) * targetAR)
	} else {
		// Source is taller → crop top/bottom.
		ch = int(float64(sw) / targetAR)
	}
	if cw < 1 {
		cw = 1
	}
	if ch < 1 {
		ch = 1
	}
	ox := b.Min.X + (sw-cw)/2
	oy := b.Min.Y + (sh-ch)/2
	crop := image.Rect(ox, oy, ox+cw, oy+ch)

	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, crop, draw.Over, nil)
	return dst
}
