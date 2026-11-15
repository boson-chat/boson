//go:build android && cgo

#include <jni.h>
#include "voice_android.h"

// The Java side is com.wails.app.BosonVoice (build/android): it registers
// itself with nativeInit once libwails.so is loaded, and Go calls its
// static methods. Calls may come from any Go thread: attach it to the VM
// for the call, and detach it again if it wasn't attached before.
static JavaVM *bv_vm;
static jclass bv_cls;

void bv_register(JNIEnv *env, jclass cls) {
	(*env)->GetJavaVM(env, &bv_vm);
	bv_cls = (jclass)(*env)->NewGlobalRef(env, cls);
}

static JNIEnv *bv_env(int *attached) {
	JNIEnv *env = NULL;
	*attached = 0;
	if (bv_vm == NULL) return NULL;
	jint st = (*bv_vm)->GetEnv(bv_vm, (void **)&env, JNI_VERSION_1_6);
	if (st == JNI_EDETACHED) {
		if ((*bv_vm)->AttachCurrentThread(bv_vm, &env, NULL) != JNI_OK) return NULL;
		*attached = 1;
	} else if (st != JNI_OK) {
		return NULL;
	}
	return env;
}

static void bv_done(JNIEnv *env, int attached) {
	if ((*env)->ExceptionCheck(env)) {
		(*env)->ExceptionDescribe(env);
		(*env)->ExceptionClear(env);
	}
	if (attached) (*bv_vm)->DetachCurrentThread(bv_vm);
}

// -1 when the Java side isn't there.
int bv_call_int(const char *name, const char *sig, int arg) {
	int attached;
	JNIEnv *env = bv_env(&attached);
	if (env == NULL) return -1;
	int r = -1;
	jmethodID m = (*env)->GetStaticMethodID(env, bv_cls, name, sig);
	if (m != NULL) r = (int)(*env)->CallStaticIntMethod(env, bv_cls, m, (jint)arg);
	bv_done(env, attached);
	return r;
}

void bv_call_void_int(const char *name, int arg) {
	int attached;
	JNIEnv *env = bv_env(&attached);
	if (env == NULL) return;
	jmethodID m = (*env)->GetStaticMethodID(env, bv_cls, name, "(I)V");
	if (m != NULL) (*env)->CallStaticVoidMethod(env, bv_cls, m, (jint)arg);
	bv_done(env, attached);
}

void bv_call_void_strings(const char *name, const char *a, const char *b) {
	int attached;
	JNIEnv *env = bv_env(&attached);
	if (env == NULL) return;
	jmethodID m = (*env)->GetStaticMethodID(env, bv_cls, name, "(Ljava/lang/String;Ljava/lang/String;)V");
	if (m != NULL) {
		jstring ja = (*env)->NewStringUTF(env, a);
		jstring jb = (*env)->NewStringUTF(env, b);
		(*env)->CallStaticVoidMethod(env, bv_cls, m, ja, jb);
		(*env)->DeleteLocalRef(env, ja);
		(*env)->DeleteLocalRef(env, jb);
	}
	bv_done(env, attached);
}
