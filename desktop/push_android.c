//go:build android && cgo

#include <jni.h>
#include <stdlib.h>
#include <string.h>
#include "push_android.h"

// The Java side is com.wails.app.BosonPush (build/android): it registers
// itself with nativeInit once libwails.so is loaded; Go calls its static
// call(String op, String arg) → String (JSON). Calls come from any Go
// thread: attached for the call, detached again if it wasn't before.
static JavaVM *bp_vm;
static jclass bp_cls;

void bp_register(JNIEnv *env, jclass cls) {
	(*env)->GetJavaVM(env, &bp_vm);
	bp_cls = (jclass)(*env)->NewGlobalRef(env, cls);
}

char *bp_call(const char *op, const char *arg) {
	if (bp_vm == NULL || bp_cls == NULL) return NULL;
	JNIEnv *env = NULL;
	int attached = 0;
	jint st = (*bp_vm)->GetEnv(bp_vm, (void **)&env, JNI_VERSION_1_6);
	if (st == JNI_EDETACHED) {
		if ((*bp_vm)->AttachCurrentThread(bp_vm, &env, NULL) != JNI_OK) return NULL;
		attached = 1;
	} else if (st != JNI_OK) {
		return NULL;
	}
	char *out = NULL;
	jmethodID m = (*env)->GetStaticMethodID(env, bp_cls, "call", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;");
	if (m != NULL) {
		jstring jo = (*env)->NewStringUTF(env, op);
		jstring ja = (*env)->NewStringUTF(env, arg);
		jstring r = (jstring)(*env)->CallStaticObjectMethod(env, bp_cls, m, jo, ja);
		if (!(*env)->ExceptionCheck(env) && r != NULL) {
			const char *s = (*env)->GetStringUTFChars(env, r, NULL);
			if (s != NULL) {
				out = strdup(s);
				(*env)->ReleaseStringUTFChars(env, r, s);
			}
			(*env)->DeleteLocalRef(env, r);
		}
		(*env)->DeleteLocalRef(env, jo);
		(*env)->DeleteLocalRef(env, ja);
	}
	if ((*env)->ExceptionCheck(env)) {
		(*env)->ExceptionDescribe(env);
		(*env)->ExceptionClear(env);
	}
	if (attached) (*bp_vm)->DetachCurrentThread(bp_vm);
	return out;
}

// A Java string as a malloc'd UTF-8 copy ("" for null); the caller frees it.
char *bp_jstring(JNIEnv *env, jstring s) {
	if (s == NULL) return strdup("");
	const char *c = (*env)->GetStringUTFChars(env, s, NULL);
	if (c == NULL) return strdup("");
	char *out = strdup(c);
	(*env)->ReleaseStringUTFChars(env, s, c);
	return out;
}
