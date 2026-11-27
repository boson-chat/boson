// Local notifications on iOS through UNUserNotificationCenter: shown while
// Boson runs or is briefly in the background (no push). See notify_ios.go.
// Manual retain/release, like the package's other Objective-C.
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#import <UIKit/UIKit.h>
#include "notify_ios.h"
#include "_cgo_export.h"

@interface BNDelegate : NSObject <UNUserNotificationCenterDelegate>
@end

@implementation BNDelegate
// In the foreground the renderer shows its own banner, so a system one only
// arrives when posted while Boson was in the background; show it anyway.
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    // A push (the extension marks them) while Boson is open: it's connected
    // and has notified in its own way already.
    if (notification.request.content.userInfo[@"boson"] != nil &&
        UIApplication.sharedApplication.applicationState == UIApplicationStateActive) {
        completionHandler(UNNotificationPresentationOptionNone);
        return;
    }
    if (@available(iOS 14.0, *)) {
        completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound);
    } else {
        completionHandler(UNNotificationPresentationOptionAlert | UNNotificationPresentationOptionSound);
    }
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler {
    if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) {
        NSDictionary *push = response.notification.request.content.userInfo[@"boson"];
        if ([push isKindOfClass:[NSDictionary class]] && [push[@"server"] isKindOfClass:[NSString class]] && [push[@"server"] length] > 0) {
            // A push notification (build/ios/push/): its conversation.
            NSString *server = [push[@"server"] isKindOfClass:[NSString class]] ? push[@"server"] : @"";
            NSString *conv = [push[@"conversation"] isKindOfClass:[NSString class]] ? push[@"conversation"] : @"";
            bosonPushTapped((char *)server.UTF8String, (char *)conv.UTF8String);
        } else {
            NSString *ident = response.notification.request.identifier ?: @"";
            bosonNotifyTapped((char *)ident.UTF8String);
        }
    }
    completionHandler();
}
@end

static BNDelegate *bnDelegate = nil;

// From main() (build/ios/main.m), before UIApplicationMain: a tap on a
// notification that launches the app is only delivered to a delegate set
// before launching finishes.
void bnInitEarly(void) {
    if (bnDelegate == nil) bnDelegate = [[BNDelegate alloc] init];
    [UNUserNotificationCenter currentNotificationCenter].delegate = bnDelegate;
}

void bnInit(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (bnDelegate == nil) bnDelegate = [[BNDelegate alloc] init];
        [UNUserNotificationCenter currentNotificationCenter].delegate = bnDelegate;
    });
}

int bnAuthorization(void) {
    __block int status = 0;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [[UNUserNotificationCenter currentNotificationCenter] getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *s) {
        switch (s.authorizationStatus) {
            case UNAuthorizationStatusNotDetermined: status = 2; break;
            case UNAuthorizationStatusDenied: status = 0; break;
            default: status = 1; break;
        }
        dispatch_semaphore_signal(done);
    }];
    dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    return status;
}

int bnRequest(void) {
    __block int ok = 0;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [[UNUserNotificationCenter currentNotificationCenter]
        requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
        completionHandler:^(BOOL granted, NSError *error) {
            ok = granted ? 1 : 0;
            dispatch_semaphore_signal(done);
        }];
    // The prompt waits for the user.
    dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC));
    return ok;
}

void bnPost(const char *ident, const char *title, const char *body, int silent) {
  @autoreleasepool {
    UNMutableNotificationContent *c = [[UNMutableNotificationContent alloc] init];
    c.title = [NSString stringWithUTF8String:title ?: ""];
    c.body = [NSString stringWithUTF8String:body ?: ""];
    if (!silent) c.sound = [UNNotificationSound defaultSound];
    NSString *i = [NSString stringWithUTF8String:ident ?: ""];
    // No trigger: now.
    UNNotificationRequest *req = [UNNotificationRequest requestWithIdentifier:i content:c trigger:nil];
    [[UNUserNotificationCenter currentNotificationCenter] addNotificationRequest:req withCompletionHandler:^(NSError *e) {
        if (e) NSLog(@"boson: notification failed: %@", e.localizedDescription);
    }];
    [c release];
  }
}

void bnRemove(const char *ident) {
  @autoreleasepool {
    NSString *i = [NSString stringWithUTF8String:ident ?: ""];
    UNUserNotificationCenter *c = [UNUserNotificationCenter currentNotificationCenter];
    [c removePendingNotificationRequestsWithIdentifiers:@[i]];
    [c removeDeliveredNotificationsWithIdentifiers:@[i]];
  }
}
