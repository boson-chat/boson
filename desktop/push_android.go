//go:build android

package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// Android push (docs/push-android.md): FCM for the device token and Play
// Integrity for the relay, both in Java (BosonPush.java, and FcmBackend.java
// in builds with Firebase); the per-server records in the app's
// EncryptedSharedPreferences, where BosonPushService (the FCM receiver)
// reads the keys to decrypt with. Builds without google-services.json have
// no FCM: Supported says so and the renderer shows push as unavailable.
type androidPush struct {
	dev bool
}

func newPushPlatform(dataDir string, dev bool) pushPlatform { return androidPush{dev: dev} }

// The Java side's answer: {"ok":…} or {"err":"<code>: <message>"}.
type pushJavaReply struct {
	OK  json.RawMessage `json:"ok"`
	Err string          `json:"err"`
}

func pushJava(op, arg string) (json.RawMessage, error) {
	raw, ok := pushJavaCall(op, arg)
	if !ok {
		return nil, pushErr("unsupported", "push isn’t available in this build")
	}
	var r pushJavaReply
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		return nil, pushErr("failed", "bad answer from the push service")
	}
	if r.Err != "" {
		if code, _, found := strings.Cut(r.Err, ": "); found {
			switch code {
			case "no-relay", "denied", "unsupported", "relay", "failed":
				return nil, errors.New(r.Err)
			}
		}
		return nil, pushErr("failed", r.Err)
	}
	return r.OK, nil
}

func pushJavaString(op, arg string) (string, error) {
	raw, err := pushJava(op, arg)
	if err != nil {
		return "", err
	}
	var s string
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &s); err != nil {
			return "", pushErr("failed", "bad answer from the push service")
		}
	}
	return s, nil
}

func (androidPush) Name() string { return "android" }

func (androidPush) Supported() string {
	s, err := pushJavaString("supported", "")
	if err != nil {
		return "Push isn’t available in this build."
	}
	return s
}

func (androidPush) Token(ctx context.Context) (string, string, error) {
	tok, err := pushJavaString("token", "")
	if err != nil {
		return "", "", err
	}
	if tok == "" {
		return "", "", pushErr("failed", "no FCM token")
	}
	return "fcm", tok, nil
}

func (a androidPush) Attest(ctx context.Context, challenge string) (pushAttestation, error) {
	// Development builds: the relay's dev allowlist, no Play verdict.
	if a.dev {
		return pushAttestation{Kind: "dev"}, nil
	}
	tok, err := pushJavaString("attest", challenge)
	if err != nil {
		return pushAttestation{}, err
	}
	return pushAttestation{Kind: "play-integrity", Data: tok}, nil
}

func (androidPush) Load(serverID string) (*pushRecord, error) {
	s, err := pushJavaString("load", serverID)
	if err != nil {
		return nil, err
	}
	if s == "" {
		return nil, errors.New("push: no record")
	}
	var rec pushRecord
	if err := json.Unmarshal([]byte(s), &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

func (androidPush) Save(rec *pushRecord) error {
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	_, err = pushJava("save", string(b))
	return err
}

func (androidPush) Delete(serverID string) error {
	_, err := pushJava("delete", serverID)
	return err
}

func (androidPush) WritePrefs(prefs []byte) error {
	_, err := pushJava("prefs", string(prefs))
	return err
}
