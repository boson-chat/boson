//go:build !(js && wasm)

package main

import (
	"fmt"
	"os"
)

// Built for anything but the browser, this command only explains itself
// (`make web-engine` builds it with GOOS=js GOARCH=wasm).
func main() {
	fmt.Fprintln(os.Stderr, "engine/cmd/wasm runs in a browser: build it with GOOS=js GOARCH=wasm")
	os.Exit(2)
}
