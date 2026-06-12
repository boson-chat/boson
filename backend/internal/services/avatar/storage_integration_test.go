package avatar

import (
	"context"
	"io"
	"net/http"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Exercises the real R2/S3 client against a live S3-compatible endpoint
// (MinIO in local dev: `make minio-up`). Skipped unless R2_TEST_ENDPOINT is
// set, so it never runs in CI. Validates the SDK wiring — custom endpoint,
// path-style addressing, "auto" region — that unit tests (fake Storage)
// can't cover.
//
//	R2_TEST_ENDPOINT=http://localhost:9000 go test ./backend/internal/services/avatar/ -run Integration -v
func TestR2Storage_Integration(t *testing.T) {
	endpoint := os.Getenv("R2_TEST_ENDPOINT")
	if endpoint == "" {
		t.Skip("set R2_TEST_ENDPOINT (e.g. http://localhost:9000) to run")
	}
	st := NewR2Storage("minioadmin", "minioadmin", endpoint, "boson")
	ctx := context.Background()
	key := "avatars/_integration_test.png"
	body := []byte("not-a-real-png-but-storage-doesnt-care")

	require.NoError(t, st.Put(ctx, key, body, "image/png"))

	// The bucket is anonymously readable in dev, so the object is fetchable
	// at the public URL the CDN base would serve.
	resp, err := http.Get(endpoint + "/boson/" + key)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	got, _ := io.ReadAll(resp.Body)
	assert.Equal(t, body, got)
	assert.Equal(t, "image/png", resp.Header.Get("Content-Type"))

	require.NoError(t, st.Delete(ctx, key))
}
