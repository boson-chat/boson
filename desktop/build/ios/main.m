//go:build ios
// Minimal bootstrap: delegate comes from Go archive (WailsAppDelegate).
// From Wails' iOS template, plus edgeToEdge() below.
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#include <stdio.h>

// Boson draws edge to edge: Wails lays its WKWebView out inside the safe area
// (below the status bar, above the home indicator), which leaves strips of
// window background around the app. After Wails' own layout, stretch the
// webview over the whole view; the page keeps its content clear of the
// status bar and home indicator with env(safe-area-inset-*) (viewport-fit=
// cover; the webview's scroll view doesn't adjust its own insets).
// Wails v3 has no option for this (beta.30).
static void edgeToEdge(void) {
    Class vc = NSClassFromString(@"WailsViewController");
    if (!vc) return;
    SEL sel = @selector(viewDidLayoutSubviews);
    Method m = class_getInstanceMethod(vc, sel);
    if (!m) return;
    typedef void (*LayoutIMP)(id, SEL);
    LayoutIMP original = (LayoutIMP)method_getImplementation(m);
    method_setImplementation(m, imp_implementationWithBlock(^(UIViewController *self_) {
        original(self_, sel);
        UIView *web = nil;
        @try {
            web = [self_ valueForKey:@"webView"];
        } @catch (NSException *e) {
            return;
        }
        // Native tabs (unused here) would sit at the bottom; leave that layout
        // to Wails.
        UIView *tabBar = nil;
        @try {
            tabBar = [self_ valueForKey:@"tabBar"];
        } @catch (NSException *e) {
        }
        if (web && (!tabBar || tabBar.isHidden)) web.frame = self_.view.bounds;
    }));
}

int main(int argc, char * argv[]) {
    @autoreleasepool {
        // Disable buffering so stdout/stderr from Go log.Printf flush immediately
        setvbuf(stdout, NULL, _IONBF, 0);
        setvbuf(stderr, NULL, _IONBF, 0);

        // Only the Objective-C runtime: the Go runtime isn't started here.
        edgeToEdge();

        // Call UIApplicationMain IMMEDIATELY and start NOTHING else here. Do not
        // start the Go runtime yet: starting it concurrently with UIApplicationMain
        // intermittently corrupts the FrontBoard launch handshake on a physical
        // device, so the app delegate's didFinishLaunchingWithOptions never fires
        // (blank cold launch / 0x8BADF00D). Instead, the WailsAppDelegate (provided
        // by the Go archive) starts the Go runtime itself from
        // didFinishLaunchingWithOptions — i.e. only AFTER UIKit has delivered the
        // launch — so the runtime never races the launch handshake.
        return UIApplicationMain(argc, argv, nil, @"WailsAppDelegate");
    }
}
