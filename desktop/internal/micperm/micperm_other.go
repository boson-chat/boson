//go:build !darwin || !cgo

package micperm

func Status() Access { return Granted }

func Request() bool { return true }
