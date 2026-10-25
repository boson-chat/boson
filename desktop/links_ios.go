//go:build ios

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework UIKit -framework SafariServices
#import <UIKit/UIKit.h>
#import <SafariServices/SafariServices.h>
#include <stdlib.h>

// The view controller on top: the key window's root, then whatever it has
// presented (a sheet, another Safari view).
static UIViewController *bosonTopViewController(void) {
	UIViewController *top = nil;
	for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
		if (![scene isKindOfClass:UIWindowScene.class]) continue;
		for (UIWindow *w in ((UIWindowScene *)scene).windows) {
			if (w.isKeyWindow) { top = w.rootViewController; break; }
		}
		if (top) break;
	}
	while (top.presentedViewController) top = top.presentedViewController;
	return top;
}

// Slides the page up over the app in Safari's own view, as Discord does:
// Done returns to the chat; the toolbar can share it or open it in Safari.
// With no view controller to present from, Safari opens it instead.
static void bosonOpenInApp(const char *curl) {
	NSURL *url = [NSURL URLWithString:[NSString stringWithUTF8String:curl]];
	if (url == nil) return;
	dispatch_async(dispatch_get_main_queue(), ^{
		UIViewController *top = bosonTopViewController();
		if (top == nil) {
			[UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil];
			return;
		}
		SFSafariViewController *vc = [[SFSafariViewController alloc] initWithURL:url];
		vc.dismissButtonStyle = SFSafariViewControllerDismissButtonStyleDone;
		vc.modalPresentationStyle = UIModalPresentationPageSheet;
		[top presentViewController:vc animated:YES completion:nil];
		[vc release];
	});
}
*/
import "C"

import "unsafe"

// openLink opens an http(s) URL in an in-app Safari view
// (SFSafariViewController) over the chat.
func openLink(url string) error {
	c := C.CString(url)
	defer C.free(unsafe.Pointer(c))
	C.bosonOpenInApp(c)
	return nil
}
