//go:build ios || android

package main

// mobileOS: an iOS or Android build. No single-instance lock (the OS runs
// one copy), no window sizing, and no default signal handlers (iOS/Android
// own the process's signals).
const mobileOS = true
