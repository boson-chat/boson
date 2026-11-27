// Push on iOS (push_ios.m, for push_ios.go).

// Adds the APNs registration callbacks to Wails' app delegate. Called from
// main() (build/ios/main.m) before UIApplicationMain.
void bpInstallHooks(void);
// Registers for remote notifications and waits for the device token (hex);
// 0 and *out (malloc'd) on success, else -1 with *out the error text.
int bpDeviceToken(char **out, int timeoutSec);
// App Attest: 1 when this device supports it.
int bpAttestSupported(void);
// A new App Attest key's id (malloc'd), or NULL with *err.
char *bpAttestGenerateKey(char **err);
// The attestation object (attest = 1) or an assertion (attest = 0) for
// keyId over clientDataHash (32 bytes), base64 (malloc'd); NULL with *err.
// *invalidKey = 1 when the key is unusable (make a new one).
char *bpAttest(const char *keyId, const unsigned char *hash, int attest, int *invalidKey, char **err);
// The App Group (Info.plist BosonAppGroup), malloc'd.
char *bpAppGroup(void);
// Keychain items shared with the extension (service chat.boson.push, the
// App Group as access group). 0 / OSStatus.
int bpKCSet(const char *account, const char *value, int len);
int bpKCGet(const char *account, char **out, int *outLen);
int bpKCDelete(const char *account);
// Writes data to a file in the App Group's container. 0 on success.
int bpWriteGroupFile(const char *name, const char *data, int len);
