//go:build android && cgo

package main

/*
#include <stdlib.h>
#include "push_android.h"
*/
import "C"

import "unsafe"

//export Java_com_wails_app_BosonPush_nativeInit
func Java_com_wails_app_BosonPush_nativeInit(env *C.JNIEnv, cls C.jclass) {
	C.bp_register(env, cls)
}

// A push notification tapped (MainActivity, BosonPush.opened): held until
// the renderer takes it, or passed on live.
//
//export Java_com_wails_app_BosonPush_nativeOpened
func Java_com_wails_app_BosonPush_nativeOpened(env *C.JNIEnv, cls C.jclass, server, conversation C.jstring) {
	s, c := jstring(env, server), jstring(env, conversation)
	if s == "" {
		return
	}
	go pushOpens.deliver(PushOpen{ServerID: s, Conversation: c})
}

func jstring(env *C.JNIEnv, s C.jstring) string {
	c := C.bp_jstring(env, s)
	defer C.free(unsafe.Pointer(c))
	return C.GoString(c)
}

// pushJavaCall: BosonPush.call(op, arg); ok false when there's no Java side.
func pushJavaCall(op, arg string) (string, bool) {
	co, ca := C.CString(op), C.CString(arg)
	defer C.free(unsafe.Pointer(co))
	defer C.free(unsafe.Pointer(ca))
	r := C.bp_call(co, ca)
	if r == nil {
		return "", false
	}
	defer C.free(unsafe.Pointer(r))
	return C.GoString(r), true
}
