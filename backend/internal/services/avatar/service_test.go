package avatar

import (
	"bytes"
	"context"
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
