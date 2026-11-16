//go:build android && cgo && !server

package main

/*
#include "voice_android.h"
*/
import "C"

import "github.com/boson-chat/quicvideo/client/media"

// BosonVoice's OrientationEventListener: how the phone is held (degrees
// clockwise from portrait), while a camera runs (cameraTurning).
//
//export Java_com_wails_app_BosonVoice_nativeOrientation
func Java_com_wails_app_BosonVoice_nativeOrientation(env *C.JNIEnv, cls C.jclass, deg C.jint) {
	media.SetDeviceOrientation(int(deg))
}
