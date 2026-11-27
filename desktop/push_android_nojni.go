//go:build android && !cgo

package main

func pushJavaCall(string, string) (string, bool) { return "", false }
