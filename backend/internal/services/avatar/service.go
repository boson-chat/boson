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
)

var (
	ErrNotConfigured    = errors.New("avatar storage not configured")
	ErrTooLarge         = errors.New("image too large")
	ErrUnsupportedImage = errors.New("unsupported or invalid image")
)

type ServiceImpl interface {
	// Configured reports whether R2 is wired up; handlers 503 when false.
	Configured() bool
	// Process validates + normalizes raw image bytes (decode → square-crop →
	// resize → re-encode PNG) and uploads to storage, returning the new
	// content-addressed object key. Best-effort deletes prevKey when set.
	Process(ctx context.Context, userID uuid.UUID, raw []byte, prevKey string) (key string, err error)
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
	if !s.Configured() {
		return "", ErrNotConfigured
	}
	if len(raw) == 0 {
		return "", ErrUnsupportedImage
	}
	if len(raw) > MaxUploadBytes {
		return "", ErrTooLarge
	}
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrUnsupportedImage, err)
	}

	out := normalizeSquare(src, avatarSize)
	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&buf, out); err != nil {
		return "", err
	}
	data := buf.Bytes()

	// Content-addressed key → each distinct avatar is a new, immutable URL,
	// so the CDN can cache forever and a change is picked up immediately.
	sum := sha256.Sum256(data)
	key := fmt.Sprintf("avatars/%s-%s.png", userID, hex.EncodeToString(sum[:6]))

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

// normalizeSquare center-crops src to a square then high-quality scales it to
// size×size, so every stored avatar is a uniform square regardless of the
// source aspect ratio.
func normalizeSquare(src image.Image, size int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	edge := w
	if h < w {
		edge = h
	}
	ox := b.Min.X + (w-edge)/2
	oy := b.Min.Y + (h-edge)/2
	crop := image.Rect(ox, oy, ox+edge, oy+edge)

	dst := image.NewRGBA(image.Rect(0, 0, size, size))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, crop, draw.Over, nil)
	return dst
}
