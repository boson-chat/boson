//go:build android && cgo

package main

func notifyJavaInt(request int) int         { return javaInt("notifyPermission", "(I)I", request) }
func notifyJavaStrings(method, a, b string) { javaVoidStrings(method, a, b) }
