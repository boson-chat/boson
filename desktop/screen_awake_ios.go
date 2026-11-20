//go:build ios

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework UIKit
#import <UIKit/UIKit.h>
#import <Foundation/Foundation.h>

// The idle timer dims and locks the screen; off while in a call. UIKit
// only on the main thread.
static void bosonKeepScreenOn(int on) {
	dispatch_async(dispatch_get_main_queue(), ^{
		UIApplication.sharedApplication.idleTimerDisabled = on ? YES : NO;
		NSLog(@"boson: idleTimerDisabled = %@ (in a voice call: %@)",
			UIApplication.sharedApplication.idleTimerDisabled ? @"YES" : @"NO", on ? @"yes" : @"no");
	});
}
*/
import "C"

// newScreenAwake keeps the iPhone from dimming and locking during a call
// (UIApplication.isIdleTimerDisabled). iOS resets it when the app ends.
func newScreenAwake() func(on bool) {
	return func(on bool) {
		v := 0
		if on {
			v = 1
		}
		C.bosonKeepScreenOn(C.int(v))
	}
}
