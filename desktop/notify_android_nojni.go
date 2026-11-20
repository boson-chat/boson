//go:build android && !cgo

package main

func notifyJavaInt(int) int                    { return 0 }
func notifyJavaStrings(string, string, string) {}
