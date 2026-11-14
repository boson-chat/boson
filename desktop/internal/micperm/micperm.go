// Package micperm reads and requests the OS microphone permission. Only
// macOS asks (TCC); elsewhere it's always granted here, and a refusal (the
// Windows privacy switch) shows up as the device failing to open.
package micperm

type Access int

const (
	Undetermined Access = iota
	Granted
	Denied
)
