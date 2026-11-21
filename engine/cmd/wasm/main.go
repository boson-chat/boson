//go:build js && wasm

// Command wasm is the engine for the web build (GOOS=js GOARCH=wasm): the
// same ipc sessions the desktop app runs in-process, here inside a Web
// Worker (client/src/renderer/src/platform/web/engine.worker.ts). The
// worker calls the functions this installs on its global scope:
//
//	bosonEngine.setGateway(url)            the IRC gateway's WebSocket URL
//	bosonEngine.open(onFrame, onClosed) →  {send(frame), close()}
//
// Each open() is one engine session (what one WebSocket is for `engine
// serve`), speaking the same JSON frames.
package main

import (
	"context"
	"syscall/js"

	"github.com/boson-chat/boson/engine/ipc"
	"github.com/boson-chat/boson/engine/irc"
)

func main() {
	api := js.Global().Get("Object").New()
	api.Set("setGateway", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) > 0 {
			irc.SetGatewayURL(args[0].String())
		}
		return nil
	}))
	api.Set("open", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) < 2 {
			return js.Null()
		}
		return openSession(args[0], args[1])
	}))
	js.Global().Set("bosonEngine", api)
	if ready := js.Global().Get("bosonEngineReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}
	select {}
}

func openSession(onFrame, onClosed js.Value) js.Value {
	ctx, cancel := context.WithCancel(context.Background())
	t := newTransport(func(frame []byte) { onFrame.Invoke(string(frame)) })
	go func() {
		ipc.ServeSession(ctx, t)
		cancel()
		onClosed.Invoke()
	}()
	handle := js.Global().Get("Object").New()
	var send, closeFn js.Func
	send = js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) > 0 {
			t.push(args[0].String())
		}
		return nil
	})
	closeFn = js.FuncOf(func(_ js.Value, _ []js.Value) any {
		t.close()
		cancel()
		go func() {
			<-ctx.Done()
			send.Release()
			closeFn.Release()
		}()
		return nil
	})
	handle.Set("send", send)
	handle.Set("close", closeFn)
	return handle
}
