//go:build darwin && cgo

package micperm

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework AVFoundation
#import <AVFoundation/AVFoundation.h>

// 0 not determined, 1 restricted, 2 denied, 3 authorized.
static int micStatus(void) {
	return (int)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
}

// Shows the system prompt (once per app) and waits for the answer.
static int micRequest(void) {
	dispatch_semaphore_t done = dispatch_semaphore_create(0);
	__block BOOL ok = NO;
	[AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
		ok = granted;
		dispatch_semaphore_signal(done);
	}];
	dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
	return ok ? 1 : 0;
}
*/
import "C"

// Status is the current permission, without asking.
func Status() Access {
	switch C.micStatus() {
	case 3:
		return Granted
	case 0:
		return Undetermined
	default:
		return Denied
	}
}

// Request asks (the system prompt, the first time) and reports the answer.
// It blocks until the user answers.
func Request() bool { return C.micRequest() == 1 }
