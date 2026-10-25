//go:build ios

package main

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <Security/Security.h>
#include <stdlib.h>
#include <string.h>

static CFMutableDictionaryRef bosonKCQuery(const char *service, const char *account) {
	CFMutableDictionaryRef q = CFDictionaryCreateMutable(NULL, 0,
		&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	CFStringRef s = CFStringCreateWithCString(NULL, service, kCFStringEncodingUTF8);
	CFStringRef a = CFStringCreateWithCString(NULL, account, kCFStringEncodingUTF8);
	CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
	CFDictionarySetValue(q, kSecAttrService, s);
	CFDictionarySetValue(q, kSecAttrAccount, a);
	CFRelease(s);
	CFRelease(a);
	return q;
}

// 0 and *out (malloc'd, caller frees) on success, else the OSStatus.
static int bosonKCGet(const char *service, const char *account, char **out, int *outLen) {
	CFMutableDictionaryRef q = bosonKCQuery(service, account);
	CFDictionarySetValue(q, kSecReturnData, kCFBooleanTrue);
	CFDictionarySetValue(q, kSecMatchLimit, kSecMatchLimitOne);
	CFTypeRef data = NULL;
	OSStatus st = SecItemCopyMatching(q, &data);
	CFRelease(q);
	if (st != errSecSuccess) return (int)st;
	CFIndex n = CFDataGetLength((CFDataRef)data);
	*out = malloc(n);
	memcpy(*out, CFDataGetBytePtr((CFDataRef)data), n);
	*outLen = (int)n;
	CFRelease(data);
	return 0;
}

static int bosonKCSet(const char *service, const char *account, const char *value, int len) {
	CFMutableDictionaryRef q = bosonKCQuery(service, account);
	CFDataRef d = CFDataCreate(NULL, (const UInt8 *)value, len);
	CFMutableDictionaryRef attrs = CFDictionaryCreateMutable(NULL, 0,
		&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	CFDictionarySetValue(attrs, kSecValueData, d);
	OSStatus st = SecItemUpdate(q, attrs);
	if (st == errSecItemNotFound) {
		CFDictionarySetValue(q, kSecValueData, d);
		// This device only (no iCloud Keychain sync), readable once the device
		// has been unlocked after boot — so also while the app runs in the
		// background.
		CFDictionarySetValue(q, kSecAttrAccessible, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly);
		st = SecItemAdd(q, NULL);
	}
	CFRelease(attrs);
	CFRelease(d);
	CFRelease(q);
	return (int)st;
}
*/
import "C"

import (
	"errors"
	"fmt"
	"unsafe"
)

// The iOS Keychain for the secure store's master key (Security framework).
// go-keyring's darwin backend runs /usr/bin/security, which iOS doesn't have.
var errKeychainNotFound = errors.New("keychain: item not found")

const errSecItemNotFound = -25300

func keychainGet(service, account string) (string, error) {
	cs, ca := C.CString(service), C.CString(account)
	defer C.free(unsafe.Pointer(cs))
	defer C.free(unsafe.Pointer(ca))
	var out *C.char
	var n C.int
	st := C.bosonKCGet(cs, ca, &out, &n)
	if st == errSecItemNotFound {
		return "", errKeychainNotFound
	}
	if st != 0 {
		return "", fmt.Errorf("keychain: SecItemCopyMatching: OSStatus %d", int(st))
	}
	defer C.free(unsafe.Pointer(out))
	return C.GoStringN(out, n), nil
}

func keychainSet(service, account, value string) error {
	cs, ca, cv := C.CString(service), C.CString(account), C.CString(value)
	defer C.free(unsafe.Pointer(cs))
	defer C.free(unsafe.Pointer(ca))
	defer C.free(unsafe.Pointer(cv))
	if st := C.bosonKCSet(cs, ca, cv, C.int(len(value))); st != 0 {
		return fmt.Errorf("keychain: SecItemAdd/Update: OSStatus %d", int(st))
	}
	return nil
}
