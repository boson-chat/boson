package com.wails.app;

import android.content.Context;

/**
 * The Firebase-dependent half of push (FcmBackend, in src/fcm/java: only
 * in builds with Firebase; docs/push-android.md). BosonPush finds it by
 * name, so builds without it compile and run, without push.
 */
interface PushBackend {
    /** The FCM registration token (blocks; off the main thread). */
    String token(Context c) throws Exception;

    /** A Play Integrity token over the relay's challenge (blocks). */
    String attest(Context c, String challenge) throws Exception;
}
