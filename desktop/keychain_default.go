//go:build !ios

package main

import (
	"errors"

	"github.com/zalando/go-keyring"
)

// The OS keychain for the secure store's master key: macOS Keychain, Windows
// Credential Manager, Secret Service on Linux (go-keyring). iOS has its own
// (keychain_ios.go).
var errKeychainNotFound = keyring.ErrNotFound

func keychainGet(service, account string) (string, error) {
	v, err := keyring.Get(service, account)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", errKeychainNotFound
	}
	return v, err
}

func keychainSet(service, account, value string) error {
	return keyring.Set(service, account, value)
}
