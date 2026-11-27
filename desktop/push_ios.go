//go:build ios

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework DeviceCheck -framework Security -framework UIKit -framework Foundation
#include <stdlib.h>
#include "push_ios.h"
#include "notify_ios.h"
#include <TargetConditionals.h>
static int bpIsSimulator(void) { return TARGET_OS_SIMULATOR ? 1 : 0; }
*/
import "C"

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"unsafe"
)

// The APNs environment this build's provisioning profile grants
// (aps-environment): "production" for App Store / TestFlight builds,
// "development" otherwise. package-ios.sh sets it from the profile.
var apnsEnvironment = "development"

// iOS: APNs for the token, App Attest for the relay, the keychain shared
// with the Notification Service Extension through the App Group for keys
// (push_ios.m).
type iosPush struct{}

func newPushPlatform(dataDir string, dev bool) pushPlatform {
	p := iosPush{}
	p.seedForTests()
	return p
}

// Simulator only: a server's keys and the settings from the launch
// environment (SIMCTL_CHILD_BOSON_PUSH_TEST_RECORD / …_PREFS), so the push
// extension can be tried with `xcrun simctl push` and no relay
// (docs/push-ios.md).
func (p iosPush) seedForTests() {
	if C.bpIsSimulator() != 1 {
		return
	}
	if raw := os.Getenv("BOSON_PUSH_TEST_RECORD"); raw != "" {
		var r pushRecord
		if err := json.Unmarshal([]byte(raw), &r); err == nil && r.ServerID != "" {
			if err := p.Save(&r); err != nil {
				log.Printf("push: test record: %v", err)
			}
		}
	}
	if raw := os.Getenv("BOSON_PUSH_TEST_PREFS"); raw != "" && json.Valid([]byte(raw)) {
		_ = p.WritePrefs([]byte(raw))
	}
}

func (iosPush) Name() string      { return "ios" }
func (iosPush) Supported() string { return "" }

func (iosPush) sandbox() bool { return apnsEnvironment != "production" }

func (p iosPush) Token(ctx context.Context) (string, string, error) {
	switch C.bnAuthorization() {
	case 0:
		return "", "", pushErr("denied", "notifications are off for Boson in Settings")
	case 2:
		if C.bnRequest() != 1 {
			return "", "", pushErr("denied", "notifications weren’t allowed")
		}
	}
	var out *C.char
	st := C.bpDeviceToken(&out, 20)
	s := C.GoString(out)
	C.free(unsafe.Pointer(out))
	if st != 0 {
		return "", "", pushErr("unsupported", "APNs registration failed: "+s)
	}
	platform := "apns"
	if p.sandbox() {
		platform = "apns-sandbox"
	}
	return platform, s, nil
}

const appAttestKeyAccount = "app-attest-key"

// Attest: development builds go through the relay's dev allowlist (no
// proof; App Attest's development environment would need its own
// entitlement). Release builds prove themselves with App Attest: the first
// mailbox on this install attests a new key, later ones assert with it.
func (p iosPush) Attest(ctx context.Context, challenge string) (pushAttestation, error) {
	if p.sandbox() {
		return pushAttestation{Kind: "dev"}, nil
	}
	if C.bpAttestSupported() != 1 {
		return pushAttestation{}, pushErr("unsupported", "this device can’t use App Attest")
	}
	hash := sha256.Sum256([]byte(challenge))
	keyID, _ := p.get(appAttestKeyAccount)
	attest := false
	for attempt := 0; attempt < 2; attempt++ {
		if keyID == "" {
			var cerr *C.char
			k := C.bpAttestGenerateKey(&cerr)
			if k == nil {
				msg := C.GoString(cerr)
				C.free(unsafe.Pointer(cerr))
				return pushAttestation{}, pushErr("failed", "App Attest: "+msg)
			}
			keyID = C.GoString(k)
			C.free(unsafe.Pointer(k))
			attest = true
		}
		ck := C.CString(keyID)
		var invalid C.int
		var cerr *C.char
		a := 0
		if attest {
			a = 1
		}
		res := C.bpAttest(ck, (*C.uchar)(unsafe.Pointer(&hash[0])), C.int(a), &invalid, &cerr)
		C.free(unsafe.Pointer(ck))
		if res != nil {
			data := C.GoString(res)
			C.free(unsafe.Pointer(res))
			if attest {
				// Kept for later mailboxes' assertions (the relay registers
				// the key with this attestation).
				_ = p.set(appAttestKeyAccount, keyID)
				return pushAttestation{Kind: "app-attest", KeyID: keyID, Data: data}, nil
			}
			return pushAttestation{Kind: "app-assert", KeyID: keyID, Data: data}, nil
		}
		msg := C.GoString(cerr)
		C.free(unsafe.Pointer(cerr))
		if invalid == 0 {
			return pushAttestation{}, pushErr("failed", "App Attest: "+msg)
		}
		// The key is gone (a restore onto another device): a new one.
		_ = p.del(appAttestKeyAccount)
		keyID = ""
	}
	return pushAttestation{}, pushErr("failed", "App Attest has no usable key")
}

func (iosPush) get(account string) (string, error) {
	ca := C.CString(account)
	defer C.free(unsafe.Pointer(ca))
	var out *C.char
	var n C.int
	if st := C.bpKCGet(ca, &out, &n); st != 0 {
		return "", fmt.Errorf("keychain: OSStatus %d", int(st))
	}
	defer C.free(unsafe.Pointer(out))
	return C.GoStringN(out, n), nil
}

func (iosPush) set(account, value string) error {
	ca, cv := C.CString(account), C.CString(value)
	defer C.free(unsafe.Pointer(ca))
	defer C.free(unsafe.Pointer(cv))
	if st := C.bpKCSet(ca, cv, C.int(len(value))); st != 0 {
		return fmt.Errorf("keychain: OSStatus %d (is the App Group entitlement there?)", int(st))
	}
	return nil
}

func (iosPush) del(account string) error {
	ca := C.CString(account)
	defer C.free(unsafe.Pointer(ca))
	if st := C.bpKCDelete(ca); st != 0 {
		return fmt.Errorf("keychain: OSStatus %d", int(st))
	}
	return nil
}

// Records live under "server:<id>" (the attest key's account is separate).
func (p iosPush) Load(serverID string) (*pushRecord, error) {
	s, err := p.get("server:" + serverID)
	if err != nil {
		return nil, err
	}
	var r pushRecord
	if err := json.Unmarshal([]byte(s), &r); err != nil {
		return nil, err
	}
	return &r, nil
}

func (p iosPush) Save(r *pushRecord) error {
	if r == nil || r.ServerID == "" {
		return errors.New("push: no record")
	}
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return p.set("server:"+r.ServerID, string(b))
}

func (p iosPush) Delete(serverID string) error { return p.del("server:" + serverID) }

func (iosPush) WritePrefs(prefs []byte) error {
	name := C.CString("push-prefs.json")
	defer C.free(unsafe.Pointer(name))
	data := C.CBytes(prefs)
	defer C.free(data)
	if C.bpWriteGroupFile(name, (*C.char)(data), C.int(len(prefs))) != 0 {
		return errors.New("push: the App Group container isn't available")
	}
	return nil
}

// A push notification tapped (notify_ios.m): open its conversation, now or
// once the renderer asks (a cold start).
//
//export bosonPushTapped
func bosonPushTapped(server, conversation *C.char) {
	pushOpens.deliver(PushOpen{ServerID: C.GoString(server), Conversation: C.GoString(conversation)})
}
