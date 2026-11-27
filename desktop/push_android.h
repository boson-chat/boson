// JNI calls to com.wails.app.BosonPush (push_android.c, for push_android.go).
#include <jni.h>

void bp_register(JNIEnv *env, jclass cls);
// BosonPush.call(op, arg): a malloc'd UTF-8 string (the caller frees it),
// NULL when the Java side isn't there.
char *bp_call(const char *op, const char *arg);
// A Java string as a malloc'd UTF-8 copy ("" for null); the caller frees it.
char *bp_jstring(JNIEnv *env, jstring s);
