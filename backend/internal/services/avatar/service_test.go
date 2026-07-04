package avatar

import (
	"bytes"
	"context"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/png"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeStorage struct {
	puts    map[string][]byte
	deleted []string
}

func newFakeStorage() *fakeStorage { return &fakeStorage{puts: map[string][]byte{}} }

func (f *fakeStorage) Put(_ context.Context, key string, data []byte, _ string) error {
	f.puts[key] = data
	return nil
}
func (f *fakeStorage) Delete(_ context.Context, key string) error {
	f.deleted = append(f.deleted, key)
	return nil
}

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

func TestProcess_NormalizesAndUploads(t *testing.T) {
	fs := newFakeStorage()
	svc := NewService(fs, "https://cdn.boson.chat/")
	uid := uuid.New()

	key, err := svc.Process(context.Background(), uid, pngBytes(t, 400, 200), "")
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(key, "avatars/"+uid.String()+"-"), "key namespaced by user: %s", key)
	assert.True(t, strings.HasSuffix(key, ".png"))

	stored, ok := fs.puts[key]
	require.True(t, ok, "object was uploaded under the returned key")
	// Stored image decodes to the normalized 256×256 square.
	img, _, err := image.Decode(bytes.NewReader(stored))
	require.NoError(t, err)
	assert.Equal(t, 256, img.Bounds().Dx())
	assert.Equal(t, 256, img.Bounds().Dy())
}

func TestProcess_DeletesPreviousObject(t *testing.T) {
	fs := newFakeStorage()
	svc := NewService(fs, "https://cdn.boson.chat")
	_, err := svc.Process(context.Background(), uuid.New(), pngBytes(t, 64, 64), "avatars/old-key.png")
	require.NoError(t, err)
	assert.Contains(t, fs.deleted, "avatars/old-key.png")
}

func TestProcessImage_BannerDimensions(t *testing.T) {
	fs := newFakeStorage()
	svc := NewService(fs, "https://cdn.boson.chat")
	key, err := svc.ProcessImage(context.Background(), "server-banners", "srv1", pngBytes(t, 2000, 1000), "", 1200, 400)
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(key, "server-banners/srv1-"), "namespaced key: %s", key)
	img, _, err := image.Decode(bytes.NewReader(fs.puts[key]))
	require.NoError(t, err)
	assert.Equal(t, 1200, img.Bounds().Dx())
	assert.Equal(t, 400, img.Bounds().Dy())
}

func TestProcess_RejectsTooLarge(t *testing.T) {
	svc := NewService(newFakeStorage(), "https://cdn.boson.chat")
	_, err := svc.Process(context.Background(), uuid.New(), make([]byte, MaxUploadBytes+1), "")
	assert.ErrorIs(t, err, ErrTooLarge)
}

func TestProcess_RejectsNonImage(t *testing.T) {
	svc := NewService(newFakeStorage(), "https://cdn.boson.chat")
	_, err := svc.Process(context.Background(), uuid.New(), []byte("this is not an image"), "")
	assert.ErrorIs(t, err, ErrUnsupportedImage)
}

// writePNGChunk appends a length-prefixed, CRC-suffixed PNG chunk.
func writePNGChunk(buf *bytes.Buffer, typ string, data []byte) {
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(data)))
	buf.Write(n[:])
	c := crc32.NewIEEE()
	_, _ = c.Write([]byte(typ))
	_, _ = c.Write(data)
	buf.WriteString(typ)
	buf.Write(data)
	var crc [4]byte
	binary.BigEndian.PutUint32(crc[:], c.Sum32())
	buf.Write(crc[:])
}

// bombPNG builds a ~45-byte PNG whose IHDR declares w×h but which carries no
// real pixel data — the classic decompression bomb: tiny on the wire, huge
// when decoded. DecodeConfig reads only the header, so the service can reject
// it before allocating the pixel buffer.
func bombPNG(w, h uint32) []byte {
	var buf bytes.Buffer
	buf.Write([]byte("\x89PNG\r\n\x1a\n")) // signature
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], w)
	binary.BigEndian.PutUint32(ihdr[4:8], h)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // color type RGBA
	writePNGChunk(&buf, "IHDR", ihdr)
	writePNGChunk(&buf, "IDAT", nil) // empty; DecodeConfig returns at first IDAT
	writePNGChunk(&buf, "IEND", nil)
	return buf.Bytes()
}

func TestProcessImage_RejectsDecompressionBomb(t *testing.T) {
	svc := NewService(newFakeStorage(), "https://cdn.boson.chat")
	bomb := bombPNG(30000, 30000) // 900M pixels declared, a handful of bytes on disk
	assert.Less(t, len(bomb), 100, "bomb payload should be tiny on the wire")
	_, err := svc.Process(context.Background(), uuid.New(), bomb, "")
	assert.ErrorIs(t, err, ErrTooLarge, "oversized decoded dimensions must be rejected pre-decode")
}

func TestProcessImage_AcceptsLargeButBoundedImage(t *testing.T) {
	// Just under the pixel cap must still be accepted (guards against an
	// over-aggressive bomb check rejecting legitimate large sources).
	fs := newFakeStorage()
	svc := NewService(fs, "https://cdn.boson.chat")
	_, err := svc.Process(context.Background(), uuid.New(), pngBytes(t, 2000, 2000), "")
	require.NoError(t, err)
}

func TestProcess_NotConfigured(t *testing.T) {
	svc := NewService(nil, "https://cdn.boson.chat")
	assert.False(t, svc.Configured())
	_, err := svc.Process(context.Background(), uuid.New(), pngBytes(t, 64, 64), "")
	assert.ErrorIs(t, err, ErrNotConfigured)
}

func TestURLFor(t *testing.T) {
	svc := NewService(newFakeStorage(), "https://cdn.boson.chat/")
	assert.Equal(t, "https://cdn.boson.chat/avatars/x.png", svc.URLFor("avatars/x.png"))
	assert.Equal(t, "", svc.URLFor(""))
}
