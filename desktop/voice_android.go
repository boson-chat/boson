//go:build android && cgo

package main

/*
#include <stdlib.h>
#include "voice_android.h"
*/
import "C"

import (
	"sync"
	"unsafe"
)

// Android: the RECORD_AUDIO permission, the in-call foreground service and
// the audio mode/routing live in Java (BosonVoice.java); the audio itself
// is miniaudio on AAudio (voice_device_android.go).

//export Java_com_wails_app_BosonVoice_nativeInit
func Java_com_wails_app_BosonVoice_nativeInit(env *C.JNIEnv, cls C.jclass) {
	C.bv_register(env, cls)
}

var (
	leaveMu sync.Mutex
	leaveFn func()
)

func setNotificationLeave(fn func()) {
	leaveMu.Lock()
	leaveFn = fn
	leaveMu.Unlock()
}

// The notification's Leave button.
//
//export Java_com_wails_app_BosonVoice_nativeLeave
func Java_com_wails_app_BosonVoice_nativeLeave(env *C.JNIEnv, cls C.jclass) {
	leaveMu.Lock()
	fn := leaveFn
	leaveMu.Unlock()
	if fn != nil {
		go fn()
	}
}

func javaInt(method, sig string, arg int) int {
	cm, cs := C.CString(method), C.CString(sig)
	defer C.free(unsafe.Pointer(cm))
	defer C.free(unsafe.Pointer(cs))
	return int(C.bv_call_int(cm, cs, C.int(arg)))
}

func javaVoidInt(method string, arg int) {
	cm := C.CString(method)
	defer C.free(unsafe.Pointer(cm))
	C.bv_call_void_int(cm, C.int(arg))
}

func javaVoidStrings(method, a, b string) {
	cm, ca, cb := C.CString(method), C.CString(a), C.CString(b)
	defer C.free(unsafe.Pointer(cm))
	defer C.free(unsafe.Pointer(ca))
	defer C.free(unsafe.Pointer(cb))
	C.bv_call_void_strings(cm, ca, cb)
}

// micPermission is RECORD_AUDIO: BosonVoice.micPermission answers 1
// granted, 0 denied, 2 not asked yet; with request it shows the system
// prompt and waits for the answer.
func micPermission(request bool) micAccess {
	r := 0
	if request {
		r = 1
	}
	switch javaInt("micPermission", "(I)I", r) {
	case 1:
		return micGranted
	case 2:
		return micUndetermined
	case -1:
		// No Java side (shouldn't happen): let the device try.
		return micGranted
	default:
		return micDenied
	}
}

// androidCalls starts and stops BosonVoice's foreground service.
type androidCalls struct{}

func newCallNotifier() callNotifier { return androidCalls{} }

func (androidCalls) CallStarted(room, server string) { javaVoidStrings("callStarted", room, server) }
func (androidCalls) CallEnded()                      { javaVoidStrings("callEnded", "", "") }
