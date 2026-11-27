// Push on iOS: the APNs device token, App Attest, and storage the
// Notification Service Extension (build/ios/push/) can read — the keychain
// shared through the App Group, and the App Group container. See push_ios.go.
// Manual retain/release, like the package's other Objective-C.
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <DeviceCheck/DeviceCheck.h>
#import <Security/Security.h>
#import <objc/runtime.h>
#include <stdlib.h>
#include <string.h>
#include "push_ios.h"

static dispatch_semaphore_t bpTokenDone = nil;
static NSString *bpToken = nil;
static NSString *bpTokenErr = nil;

static char *bpCopy(NSString *s) {
    const char *u = (s ?: @"").UTF8String;
    char *out = malloc(strlen(u) + 1);
    strcpy(out, u);
    return out;
}

static void bpGotToken(id self_, SEL _cmd, UIApplication *app, NSData *token) {
    NSMutableString *hex = [NSMutableString stringWithCapacity:token.length * 2];
    const unsigned char *b = token.bytes;
    for (NSUInteger i = 0; i < token.length; i++) [hex appendFormat:@"%02x", b[i]];
    @synchronized ([UIApplication class]) {
        [bpToken release];
        bpToken = [hex copy];
        [bpTokenErr release];
        bpTokenErr = nil;
    }
    if (bpTokenDone) dispatch_semaphore_signal(bpTokenDone);
}

static void bpTokenFailed(id self_, SEL _cmd, UIApplication *app, NSError *error) {
    @synchronized ([UIApplication class]) {
        [bpTokenErr release];
        bpTokenErr = [error.localizedDescription copy];
    }
    if (bpTokenDone) dispatch_semaphore_signal(bpTokenDone);
}

void bpInstallHooks(void) {
    Class d = NSClassFromString(@"WailsAppDelegate");
    if (!d) return;
    class_addMethod(d, @selector(application:didRegisterForRemoteNotificationsWithDeviceToken:), (IMP)bpGotToken, "v@:@@");
    class_addMethod(d, @selector(application:didFailToRegisterForRemoteNotificationsWithError:), (IMP)bpTokenFailed, "v@:@@");
}

int bpDeviceToken(char **out, int timeoutSec) {
    if (!bpTokenDone) bpTokenDone = dispatch_semaphore_create(0);
    // A fresh token each time (iOS hands the current one back quickly).
    while (dispatch_semaphore_wait(bpTokenDone, DISPATCH_TIME_NOW) == 0) {}
    dispatch_async(dispatch_get_main_queue(), ^{
        [UIApplication.sharedApplication registerForRemoteNotifications];
    });
    long timedOut = dispatch_semaphore_wait(bpTokenDone, dispatch_time(DISPATCH_TIME_NOW, (int64_t)timeoutSec * NSEC_PER_SEC));
    @synchronized ([UIApplication class]) {
        if (timedOut) { *out = bpCopy(@"no answer from APNs"); return -1; }
        if (bpTokenErr) { *out = bpCopy(bpTokenErr); return -1; }
        *out = bpCopy(bpToken);
        return 0;
    }
}

int bpAttestSupported(void) {
    if (@available(iOS 14.0, *)) return DCAppAttestService.sharedService.isSupported ? 1 : 0;
    return 0;
}

char *bpAttestGenerateKey(char **err) {
    if (@available(iOS 14.0, *)) {
        __block NSString *kid = nil, *e = nil;
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        [DCAppAttestService.sharedService generateKeyWithCompletionHandler:^(NSString *keyId, NSError *error) {
            kid = [keyId copy];
            e = [error.localizedDescription copy];
            dispatch_semaphore_signal(done);
        }];
        dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
        dispatch_release(done);
        if (!kid) { *err = bpCopy(e ?: @"App Attest gave no key"); [e release]; return NULL; }
        char *r = bpCopy(kid);
        [kid release];
        [e release];
        return r;
    }
    *err = bpCopy(@"App Attest needs iOS 14");
    return NULL;
}

char *bpAttest(const char *keyId, const unsigned char *hash, int attest, int *invalidKey, char **err) {
    *invalidKey = 0;
    if (@available(iOS 14.0, *)) {
        NSString *kid = [NSString stringWithUTF8String:keyId];
        NSData *h = [NSData dataWithBytes:hash length:32];
        __block NSData *res = nil;
        __block NSError *e = nil;
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        void (^fin)(NSData *, NSError *) = ^(NSData *d, NSError *error) {
            res = [d retain];
            e = [error retain];
            dispatch_semaphore_signal(done);
        };
        if (attest) [DCAppAttestService.sharedService attestKey:kid clientDataHash:h completionHandler:fin];
        else [DCAppAttestService.sharedService generateAssertion:kid clientDataHash:h completionHandler:fin];
        dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
        dispatch_release(done);
        if (!res) {
            if (e && [e.domain isEqualToString:DCErrorDomain] && e.code == DCErrorInvalidKey) *invalidKey = 1;
            *err = bpCopy(e.localizedDescription ?: @"App Attest failed");
            [e release];
            return NULL;
        }
        char *r = bpCopy([res base64EncodedStringWithOptions:0]);
        [res release];
        [e release];
        return r;
    }
    *err = bpCopy(@"App Attest needs iOS 14");
    return NULL;
}

static NSString *bpGroup(void) {
    NSString *g = [NSBundle.mainBundle objectForInfoDictionaryKey:@"BosonAppGroup"];
    return g.length ? g : @"group.chat.boson.app";
}

char *bpAppGroup(void) { return bpCopy(bpGroup()); }

static NSMutableDictionary *bpQuery(const char *account) {
    NSMutableDictionary *q = [NSMutableDictionary dictionary];
    q[(id)kSecClass] = (id)kSecClassGenericPassword;
    q[(id)kSecAttrService] = @"chat.boson.push";
    q[(id)kSecAttrAccessGroup] = bpGroup();
    if (account) q[(id)kSecAttrAccount] = [NSString stringWithUTF8String:account];
    return q;
}

int bpKCSet(const char *account, const char *value, int len) {
  @autoreleasepool {
    NSMutableDictionary *q = bpQuery(account);
    NSData *d = [NSData dataWithBytes:value length:len];
    OSStatus st = SecItemUpdate((CFDictionaryRef)q, (CFDictionaryRef)@{(id)kSecValueData: d});
    if (st == errSecItemNotFound) {
        q[(id)kSecValueData] = d;
        // This device only; readable once it has been unlocked after boot,
        // which is when the extension runs for a locked phone.
        q[(id)kSecAttrAccessible] = (id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
        st = SecItemAdd((CFDictionaryRef)q, NULL);
    }
    return (int)st;
  }
}

int bpKCGet(const char *account, char **out, int *outLen) {
  @autoreleasepool {
    NSMutableDictionary *q = bpQuery(account);
    q[(id)kSecReturnData] = @YES;
    q[(id)kSecMatchLimit] = (id)kSecMatchLimitOne;
    CFTypeRef data = NULL;
    OSStatus st = SecItemCopyMatching((CFDictionaryRef)q, &data);
    if (st != errSecSuccess) return (int)st;
    NSData *d = (NSData *)data;
    *out = malloc(d.length);
    memcpy(*out, d.bytes, d.length);
    *outLen = (int)d.length;
    CFRelease(data);
    return 0;
  }
}

int bpKCDelete(const char *account) {
  @autoreleasepool {
    OSStatus st = SecItemDelete((CFDictionaryRef)bpQuery(account));
    return st == errSecItemNotFound ? 0 : (int)st;
  }
}

int bpWriteGroupFile(const char *name, const char *data, int len) {
  @autoreleasepool {
    NSURL *dir = [NSFileManager.defaultManager containerURLForSecurityApplicationGroupIdentifier:bpGroup()];
    if (!dir) return -1;
    NSURL *f = [dir URLByAppendingPathComponent:[NSString stringWithUTF8String:name]];
    NSData *d = [NSData dataWithBytes:data length:len];
    return [d writeToURL:f options:NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication error:nil] ? 0 : -1;
  }
}
