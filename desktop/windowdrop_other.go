//go:build !darwin || ios || server

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// Only macOS's window registers for file drops itself (windowdrop_darwin.go).
func stopWindowFileDrops(*application.WebviewWindow) {}
