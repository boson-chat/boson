package com.wails.app;

import android.content.Context;
import android.util.Base64;

import com.google.android.gms.tasks.Tasks;
import com.google.android.play.core.integrity.IntegrityManagerFactory;
import com.google.android.play.core.integrity.IntegrityTokenRequest;
import com.google.android.play.core.integrity.IntegrityTokenResponse;
import com.google.firebase.messaging.FirebaseMessaging;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * FCM token and Play Integrity, for builds with Firebase (src/fcm: added by
 * app/build.gradle when google-services.json is there or -PbosonFcm=1).
 * Loaded by name from BosonPush.
 */
public final class FcmBackend implements PushBackend {
    private static final Pattern NONCE = Pattern.compile("^[A-Za-z0-9_-]{16,500}$");

    @Override
    public String token(Context c) throws Exception {
        return Tasks.await(FirebaseMessaging.getInstance().getToken(), 30, TimeUnit.SECONDS);
    }

    /**
     * The Integrity nonce: what push_android.go passes, base64url (no
     * padding) of SHA-256 of the relay's client data, which binds the
     * challenge to this mailbox (the relay checks it as the token's nonce).
     * Anything else is encoded the same way.
     */
    static String nonceFor(String binding) {
        if (NONCE.matcher(binding).matches()) return binding;
        return Base64.encodeToString(binding.getBytes(StandardCharsets.UTF_8), Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    @Override
    public String attest(Context c, String binding) throws Exception {
        IntegrityTokenRequest.Builder req = IntegrityTokenRequest.builder().setNonce(nonceFor(binding));
        if (BuildConfig.BOSON_CLOUD_PROJECT != 0L) req.setCloudProjectNumber(BuildConfig.BOSON_CLOUD_PROJECT);
        IntegrityTokenResponse r = Tasks.await(
                IntegrityManagerFactory.create(c.getApplicationContext()).requestIntegrityToken(req.build()), 30, TimeUnit.SECONDS);
        return r.token();
    }
}
