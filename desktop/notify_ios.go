//go:build ios

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework UserNotifications -framework Foundation
#include <stdlib.h>
#include "notify_ios.h"
*/
import "C"

import (
	"context"
	"sync"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// iOS: UNUserNotificationCenter, while the app runs or is briefly in the
// background. The first request shows the system prompt.
type iosNotifier struct{}

var (
	iosTapMu sync.Mutex
	iosTap   func(id string)
)

func newPlatformNotifier() platformNotifier { return iosNotifier{} }

func (iosNotifier) start(context.Context, application.ServiceOptions) error {
	C.bnInit()
	return nil
}
func (iosNotifier) stop() error { return nil }

func (iosNotifier) authorized() (bool, bool, error) {
	s := C.bnAuthorization()
	return s == 1, s != 2, nil
}

func (iosNotifier) request() (bool, error) { return C.bnRequest() == 1, nil }

func (iosNotifier) send(id, title, body string, silent bool) error {
	ci, ct, cb := C.CString(id), C.CString(title), C.CString(body)
	defer C.free(unsafe.Pointer(ci))
	defer C.free(unsafe.Pointer(ct))
	defer C.free(unsafe.Pointer(cb))
	s := 0
	if silent {
		s = 1
	}
	C.bnPost(ci, ct, cb, C.int(s))
	return nil
}

func (iosNotifier) remove(id string) error {
	ci := C.CString(id)
	defer C.free(unsafe.Pointer(ci))
	C.bnRemove(ci)
	return nil
}

func (iosNotifier) onClick(fn func(id string)) {
	iosTapMu.Lock()
	iosTap = fn
	iosTapMu.Unlock()
}

//export bosonNotifyTapped
func bosonNotifyTapped(id *C.char) {
	s := C.GoString(id)
	iosTapMu.Lock()
	fn := iosTap
	iosTapMu.Unlock()
	if fn != nil {
		go fn(s)
	}
}
