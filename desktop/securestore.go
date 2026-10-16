package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// SecureStore keeps short secrets (identity, bouncer and services
// credentials) in <data dir>/identity-store.json, a flat JSON object of
// tagged ciphertexts:
//
//	"kc1:<base64 iv||tag||ct>" — AES-256-GCM under a random master key held
//	                             in the OS keychain (preferred)
//	"fb1:<base64 iv||tag||ct>" — AES-256-GCM under a key derived from the OS
//	                             user + hostname; for hosts without a keychain
//	                             (headless Linux). Same format as the former
//	                             Electron build, so those values carry over.
//	"ks1:…" / untagged          — the former Electron build's safeStorage;
//	                             unreadable here, read as missing.
//
// Only the 32-byte master key goes in the keychain, not the values: Windows
// Credential Manager caps an entry at ~2.5 KB.
type SecureStore struct {
	path   string
	forced string // "derived" to skip the keychain (dev/e2e builds)

	mu    sync.Mutex
	cache map[string]string
	key   []byte // keychain master key, once read or created
	// keyErr: why the keychain last couldn't give the master key (nil when
	// it could, or wasn't asked — forced "derived").
	keyErr error
}

const (
	storeFile        = "identity-store.json"
	tagKeychain      = "kc1:"
	tagFallback      = "fb1:"
	fallbackSalt     = "boson-secure-store-fallback-v1"
	keyringService   = "Boson"
	keyringMasterKey = "secure-store-master-key"
)

func NewSecureStore(dataDir, forced string) *SecureStore {
	return &SecureStore{path: filepath.Join(dataDir, storeFile), forced: forced}
}

// Mode is "keychain", "derived" or "none".
func (s *SecureStore) Mode() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mode()
}

func (s *SecureStore) mode() string {
	if s.forced != "derived" {
		_, err := s.masterKey()
		s.keyErr = err
		if err == nil {
			return "keychain"
		}
	}
	if _, err := fallbackKey(); err == nil {
		return "derived"
	}
	return "none"
}

func (s *SecureStore) IsAvailable() bool { return s.Mode() != "none" }

// modeReport is Mode plus why the keychain wasn't used, for dev logs. It
// never asks the keychain when the store is forced to "derived" (e2e
// builds, whose throwaway HOME has no keychain: asking makes macOS prompt).
func (s *SecureStore) modeReport() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.mode()
	if s.keyErr != nil {
		return m + " (keychain: " + s.keyErr.Error() + ")"
	}
	return m
}

// The bound methods take untyped arguments and check them, with the former
// Electron IPC handlers' messages: a broken renderer gets a clear error
// rather than a silently desynced store.
func storeKey(op string, key any) (string, error) {
	k, ok := key.(string)
	if !ok || k == "" {
		return "", errors.New("secureStore:" + op + " requires a non-empty string key")
	}
	return k, nil
}

func (s *SecureStore) Get(key any) (*string, error) {
	k, err := storeKey("get", key)
	if err != nil {
		return nil, err
	}
	return s.get(k), nil
}

func (s *SecureStore) Set(key, value any) error {
	k, err := storeKey("set", key)
	if err != nil {
		return err
	}
	v, ok := value.(string)
	if !ok {
		return errors.New("secureStore:set requires a string value")
	}
	return s.set(k, v)
}

func (s *SecureStore) Remove(key any) error {
	k, err := storeKey("remove", key)
	if err != nil {
		return err
	}
	return s.remove(k)
}

// get returns the value, or nil when it's missing or can't be decrypted
// (another user's or machine's ciphertext, a corrupt file).
func (s *SecureStore) get(key string) *string {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, ok := s.load()[key]
	if !ok {
		return nil
	}
	var k []byte
	var err error
	switch {
	case strings.HasPrefix(raw, tagKeychain):
		k, err = s.masterKey()
	case strings.HasPrefix(raw, tagFallback):
		k, err = fallbackKey()
	default:
		return nil
	}
	if err != nil {
		return nil
	}
	v, err := open(k, raw[len(tagKeychain):])
	if err != nil {
		return nil
	}
	return &v
}

func (s *SecureStore) set(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var tag string
	var k []byte
	var err error
	switch s.mode() {
	case "keychain":
		tag = tagKeychain
		k, err = s.masterKey()
	case "derived":
		tag = tagFallback
		k, err = fallbackKey()
	default:
		return nil
	}
	if err != nil {
		return err
	}
	ct, err := seal(k, value)
	if err != nil {
		return err
	}
	data := s.load()
	data[key] = tag + ct
	return s.persist(data)
}

func (s *SecureStore) remove(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := s.load()
	if _, ok := data[key]; !ok {
		return nil
	}
	delete(data, key)
	return s.persist(data)
}

// ----- internals (callers hold s.mu) -----

func (s *SecureStore) load() map[string]string {
	if s.cache != nil {
		return s.cache
	}
	s.cache = map[string]string{}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return s.cache
	}
	var parsed map[string]any
	if json.Unmarshal(raw, &parsed) != nil {
		return s.cache // a broken file isn't useful; the next write replaces it
	}
	for k, v := range parsed {
		if str, ok := v.(string); ok {
			s.cache[k] = str
		}
	}
	return s.cache
}

func (s *SecureStore) persist(data map[string]string) error {
	s.cache = data
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *SecureStore) masterKey() ([]byte, error) {
	if s.key != nil {
		return s.key, nil
	}
	enc, err := keychainGet(keyringService, keyringMasterKey)
	if errors.Is(err, errKeychainNotFound) {
		k := make([]byte, 32)
		if _, err := rand.Read(k); err != nil {
			return nil, err
		}
		enc = base64.StdEncoding.EncodeToString(k)
		if err := keychainSet(keyringService, keyringMasterKey, enc); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	k, err := base64.StdEncoding.DecodeString(enc)
	if err != nil || len(k) != 32 {
		return nil, errors.New("secure store: bad master key in keychain")
	}
	s.key = k
	return k, nil
}

// fallbackKey matches the former Electron build's derived key:
// sha256(username::hostname::salt), where username is the bare login name.
func fallbackKey() ([]byte, error) {
	u, err := user.Current()
	if err != nil {
		return nil, err
	}
	name := u.Username
	if runtime.GOOS == "windows" {
		// Go reports DOMAIN\user; Node's os.userInfo() reports user.
		if i := strings.LastIndex(name, `\`); i >= 0 {
			name = name[i+1:]
		}
	}
	host, err := os.Hostname()
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(name + "::" + host + "::" + fallbackSalt))
	return sum[:], nil
}

// seal/open: base64(iv(12) || tag(16) || ciphertext), the former Electron layout.
// Go's GCM appends the tag to the ciphertext, so it's moved in front.
func seal(key []byte, plaintext string) (string, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	out := gcm.Seal(nil, iv, []byte(plaintext), nil)
	ct, tag := out[:len(out)-gcm.Overhead()], out[len(out)-gcm.Overhead():]
	blob := append(append(append([]byte{}, iv...), tag...), ct...)
	return base64.StdEncoding.EncodeToString(blob), nil
}

func open(key []byte, b64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", err
	}
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	ns, ts := gcm.NonceSize(), gcm.Overhead()
	if len(raw) < ns+ts {
		return "", errors.New("short ciphertext")
	}
	iv, tag, ct := raw[:ns], raw[ns:ns+ts], raw[ns+ts:]
	pt, err := gcm.Open(nil, iv, append(append([]byte{}, ct...), tag...), nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
