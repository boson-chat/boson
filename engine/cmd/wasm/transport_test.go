package main

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestTransportOrderAndClose(t *testing.T) {
	var out [][]byte
	tr := newTransport(func(b []byte) { out = append(out, b) })
	tr.push("a")
	tr.push("b")
	ctx := context.Background()
	f, err := tr.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, "a", string(f))
	f, err = tr.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, "b", string(f))

	got := make(chan string, 1)
	go func() {
		f, _ := tr.Read(ctx)
		got <- string(f)
	}()
	time.Sleep(10 * time.Millisecond)
	tr.push("c")
	require.Equal(t, "c", <-got)

	require.NoError(t, tr.Write(ctx, []byte("x")))
	require.Equal(t, "x", string(out[0]))

	tr.close()
	tr.close()
	tr.push("ignored")
	_, err = tr.Read(ctx)
	require.ErrorIs(t, err, errClosed)
	require.ErrorIs(t, tr.Write(ctx, []byte("y")), errClosed)

	cctx, cancel := context.WithCancel(ctx)
	cancel()
	_, err = newTransport(func([]byte) {}).Read(cctx)
	require.ErrorIs(t, err, context.Canceled)
}
