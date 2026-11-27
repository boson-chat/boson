//go:build ios
// Minimal bootstrap: delegate comes from Go archive (WailsAppDelegate).
// From Wails' iOS template, plus BosonSceneDelegate and edgeToEdge() below.
#import <UIKit/UIKit.h>
#import <Network/Network.h>
#import <objc/runtime.h>
#include <stdio.h>

// Boson draws edge to edge: Wails lays its WKWebView out inside the safe area
// (below the status bar, above the home indicator), which leaves strips of
// window background around the app. After Wails' own layout, stretch the
// webview over the whole view; the page keeps its content clear of the
// status bar and home indicator with env(safe-area-inset-*) (viewport-fit=
// cover; the webview's scroll view doesn't adjust its own insets).
// Wails v3 has no option for this (beta.30).
// The app's webview, once Wails has made it (see edgeToEdge); for
// watchNetwork. It lives as long as the app.
static UIView *bosonWebView = nil;

// Tell the page the moment the network changes — Wi-Fi lost, a switch to
// cellular, back online — so it checks its IRC connections right away
// (a connection on the old interface is dead, but nothing on the wire says
// so until the server's ping timeout, minutes later). The page listens for
// "boson:network" (DirectoryBloc); detail.online says whether there's a
// usable path at all.
static void watchNetwork(void) {
    nw_path_monitor_t monitor = nw_path_monitor_create();
    nw_path_monitor_set_queue(monitor, dispatch_get_main_queue());
    __block BOOL first = YES;
    __block int lastKey = -1;
    nw_path_monitor_set_update_handler(monitor, ^(nw_path_t path) {
        BOOL online = nw_path_get_status(path) == nw_path_status_satisfied;
        // The monitor reports every path update, and on cellular those come
        // often with nothing that matters to a TCP connection (expensive /
        // constrained flags, DNS, the radio's own state). Only a change of
        // reachability or interface (Wi-Fi <-> cellular) is passed on.
        int key = (online ? 1 : 0)
            | (nw_path_uses_interface_type(path, nw_interface_type_wifi) ? 2 : 0)
            | (nw_path_uses_interface_type(path, nw_interface_type_cellular) ? 4 : 0)
            | (nw_path_uses_interface_type(path, nw_interface_type_wired) ? 8 : 0);
        if (key == lastKey) return;
        lastKey = key;
        // The first update is the state at start, not a change.
        if (first) { first = NO; return; }
        if (![bosonWebView respondsToSelector:@selector(evaluateJavaScript:completionHandler:)]) return;
        NSString *js = [NSString stringWithFormat:
            @"window.dispatchEvent(new CustomEvent('boson:network', { detail: { online: %@ } }))",
            online ? @"true" : @"false"];
        [(id)bosonWebView evaluateJavaScript:js completionHandler:nil];
    });
    nw_path_monitor_start(monitor);
}

// No form accessory bar (the ⌃ ⌄ ✓ row WKWebView puts over the keyboard
// for a focused field): an app's composer, not a web form, and the row
// costs a line of the screen. WKContentView (WebKit's private view that
// takes the keyboard) answers inputAccessoryView with that bar; give the
// class its own answer, nil. class_replaceMethod adds the override on
// WKContentView itself (it would otherwise inherit UIResponder's), so no
// other responder changes. A WebKit without the class: nothing happens.
static void hideFormAccessoryBar(void) {
    Class content = NSClassFromString(@"WKContentView");
    if (!content) return;
    SEL sel = @selector(inputAccessoryView);
    if (!class_getInstanceMethod(content, sel)) return;
    IMP none = imp_implementationWithBlock(^UIView *(id self_) { return nil; });
    class_replaceMethod(content, sel, none, "@@:");
}

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
        if (web && !bosonWebView) {
            bosonWebView = web;
            watchNetwork();
            // (WebKit is surely loaded by now: here's its view.)
            hideFormAccessoryBar();
        }
        // An app, not a web page: no pinch zoom (the viewport meta asks
        // for that too; this holds whatever the page says). On a phone the
        // page is laid out narrower and shown a size up (PHONE_SCALE in
        // client shared/phone-scale.ts), so that's the scale to hold.
        if ([web respondsToSelector:@selector(scrollView)]) {
            UIScrollView *sv = [(id)web scrollView];
            CGFloat scale = UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPhone ? 1.15 : 1.0;
            sv.minimumZoomScale = scale;
            sv.maximumZoomScale = scale;
            sv.bouncesZoom = NO;
            // Nor does the page itself scroll: only its panes do (the
            // message list, the channel list …, each its own scroller that
            // this doesn't touch). The page is exactly the screen, but this
            // scroll view still rubber-bands, and with the keyboard up
            // WebKit insets it by the keyboard's height, so the whole page
            // could be dragged, with a second scroll bar beside the message
            // list's. WebKit's own scroll to a focused field is
            // programmatic and still happens; the page follows it (client
            // shared/visual-viewport.ts).
            sv.scrollEnabled = NO;
            sv.bounces = NO;
            sv.alwaysBounceVertical = NO;
            sv.alwaysBounceHorizontal = NO;
            sv.showsVerticalScrollIndicator = NO;
            sv.showsHorizontalScrollIndicator = NO;
        }
    }));
}

// iOS 27's SDK requires the UIScene life cycle ("Application failed to
// launch: UIScene life cycle is required for apps built with this SDK");
// Wails v3 beta.30's iOS host only has an app delegate. Info.plist declares
// one window scene with this delegate, which:
//   - shows the window Wails' delegate made in didFinishLaunching (before any
//     scene connects) in the connected scene;
//   - forwards the life-cycle callbacks iOS now sends to the scene, not the
//     app delegate, to Wails' delegate (its active/background events);
//   - forwards URLs (boson://), at launch and later, to the app delegate's
//     application:openURL:options:;
//   - asks for background time on leaving the screen, so a quick trip to
//     another app doesn't drop the IRC connections (iOS suspends an app
//     within seconds otherwise; this buys about 30s).
@interface BosonSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property (strong, nonatomic) UIWindow *window;
@property (nonatomic) UIBackgroundTaskIdentifier grace;
@end

@implementation BosonSceneDelegate
- (id<UIApplicationDelegate>)appDelegate {
    return UIApplication.sharedApplication.delegate;
}
- (void)openURLContexts:(NSSet<UIOpenURLContext *> *)contexts {
    id<UIApplicationDelegate> d = [self appDelegate];
    if (![d respondsToSelector:@selector(application:openURL:options:)]) return;
    for (UIOpenURLContext *c in contexts) {
        [d application:UIApplication.sharedApplication openURL:c.URL options:@{}];
    }
}
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    if (![scene isKindOfClass:[UIWindowScene class]]) return;
    UIWindow *w = [self appDelegate].window;
    if (!w) {
        w = [[UIWindow alloc] init];
        w.rootViewController = [[UIViewController alloc] init];
    }
    w.windowScene = (UIWindowScene *)scene;
    w.frame = ((UIWindowScene *)scene).coordinateSpace.bounds;
    self.window = w;
    [w makeKeyAndVisible];
    if (options.URLContexts.count > 0) [self openURLContexts:options.URLContexts];
}
- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)contexts {
    [self openURLContexts:contexts];
}
- (void)sceneDidBecomeActive:(UIScene *)scene {
    id d = [self appDelegate];
    if ([d respondsToSelector:@selector(applicationDidBecomeActive:)]) [d applicationDidBecomeActive:UIApplication.sharedApplication];
}
- (void)sceneWillResignActive:(UIScene *)scene {
    id d = [self appDelegate];
    if ([d respondsToSelector:@selector(applicationWillResignActive:)]) [d applicationWillResignActive:UIApplication.sharedApplication];
}
- (void)endGrace {
    if (self.grace == UIBackgroundTaskInvalid) return;
    [UIApplication.sharedApplication endBackgroundTask:self.grace];
    self.grace = UIBackgroundTaskInvalid;
}
- (void)sceneWillEnterForeground:(UIScene *)scene {
    [self endGrace];
    id d = [self appDelegate];
    if ([d respondsToSelector:@selector(applicationWillEnterForeground:)]) [d applicationWillEnterForeground:UIApplication.sharedApplication];
}
- (void)sceneDidEnterBackground:(UIScene *)scene {
    [self endGrace];
    // (Manual reference counting here, so no __weak; the scene delegate
    // lives as long as the app anyway.)
    self.grace = [UIApplication.sharedApplication beginBackgroundTaskWithName:@"Stay connected"
                                                            expirationHandler:^{ [self endGrace]; }];
    id d = [self appDelegate];
    if ([d respondsToSelector:@selector(applicationDidEnterBackground:)]) [d applicationDidEnterBackground:UIApplication.sharedApplication];
}
@end

// From the Go archive (notify_ios.m, push_ios.m): the notification
// centre's delegate, set before launch so a tap that starts the app reaches
// it, and the APNs token callbacks on Wails' app delegate.
extern void bnInitEarly(void);
extern void bpInstallHooks(void);

int main(int argc, char * argv[]) {
    @autoreleasepool {
        // Disable buffering so stdout/stderr from Go log.Printf flush immediately
        setvbuf(stdout, NULL, _IONBF, 0);
        setvbuf(stderr, NULL, _IONBF, 0);

        // Only the Objective-C runtime: the Go runtime isn't started here.
        edgeToEdge();
        bnInitEarly();
        bpInstallHooks();

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
