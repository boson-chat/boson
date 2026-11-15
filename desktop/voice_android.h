// JNI calls to com.wails.app.BosonVoice (voice_android.c, for
// voice_android.go).
#include <jni.h>

void bv_register(JNIEnv *env, jclass cls);
// The static method name(sig) with an int argument; -1 when the Java side
// isn't there.
int bv_call_int(const char *name, const char *sig, int arg);
void bv_call_void_int(const char *name, int arg);
void bv_call_void_strings(const char *name, const char *a, const char *b);
