//go:build !android

package main

import "errors"

func installAPK(string) error { return errors.New("updater: APKs install on Android only") }
