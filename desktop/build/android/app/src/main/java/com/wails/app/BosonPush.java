package com.wails.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationManagerCompat;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * Push notifications (docs/push.md §3, docs/push-android.md): the Java side
 * of desktop/push_android.go. Go calls call(op, arg) → JSON
 * {"ok": …} | {"err": "<code>: <message>"}:
 *
 *   supported            "" or why not
 *   token                the FCM token
 *   attest <binding>     a Play Integrity token, nonce = <binding>
 *                        (base64url SHA-256 of the relay's client data)
 *   load <serverId>      the server's record JSON ("" none)
 *   save <record JSON>   (keyed by its serverId)
 *   delete <serverId>
 *   prefs <PushPrefs JSON>  the settings BosonPushService filters by
 *
 * Records hold each server's private key and auth secret, so they live in
 * EncryptedSharedPreferences (a Keystore-backed key). BosonPushService
 * reads them to decrypt (records()).
 */
public final class BosonPush {
    private static final String TAG = "BosonPush";
    static final String RECORDS = "boson_push";
    static final String PREFS = "boson_push_prefs";
    static final String PREFS_KEY = "prefs";
    /** MainActivity extras of a tapped push notification. */
    static final String EXTRA_SERVER = "push_server";
    static final String EXTRA_TARGET = "push_target";

    private static volatile Context app;
    /** MainActivity is on screen: the page notifies by itself. */
    static volatile boolean foreground;

    private BosonPush() {}

    static native void nativeInit();
    static native void nativeOpened(String server, String conversation);

    /** From MainActivity.onCreate, once libwails.so is loaded. */
    public static void init(Context c) {
        app = c.getApplicationContext();
        try {
            nativeInit();
        } catch (UnsatisfiedLinkError e) {
            Log.w(TAG, "no push bridge in this build", e);
        }
    }

    /** A tapped push notification (MainActivity's intent): open its buffer. */
    public static void deliverTap(Intent intent) {
        if (intent == null) return;
        String server = intent.getStringExtra(EXTRA_SERVER);
        if (server == null || server.isEmpty()) return;
        String target = intent.getStringExtra(EXTRA_TARGET);
        intent.removeExtra(EXTRA_SERVER);
        intent.removeExtra(EXTRA_TARGET);
        try {
            nativeOpened(server, target == null ? "" : target);
        } catch (UnsatisfiedLinkError e) {
            Log.w(TAG, "push tap: no native side", e);
        }
    }

    static PushBackend backend() {
        if (!BuildConfig.BOSON_FCM) return null;
        try {
            return (PushBackend) Class.forName("com.wails.app.FcmBackend").getDeclaredConstructor().newInstance();
        } catch (Exception e) {
            Log.w(TAG, "FCM backend missing", e);
            return null;
        }
    }

    static SharedPreferences records(Context c) throws Exception {
        MasterKey key = new MasterKey.Builder(c).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
        return EncryptedSharedPreferences.create(c, RECORDS, key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    }

    /** Every server's record. */
    static List<JSONObject> allRecords(Context c) {
        List<JSONObject> out = new ArrayList<>();
        try {
            for (Map.Entry<String, ?> e : records(c).getAll().entrySet()) {
                if (!(e.getValue() instanceof String)) continue;
                try {
                    out.add(new JSONObject((String) e.getValue()));
                } catch (JSONException ignored) { }
            }
        } catch (Exception e) {
            Log.w(TAG, "reading push records failed", e);
        }
        return out;
    }

    /** The settings mirrored from the renderer (filter.ts PushPrefs). */
    static PushFilter filter(Context c) {
        PushFilter f = new PushFilter();
        String raw = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PREFS_KEY, null);
        if (raw == null) return f;
        try {
            JSONObject p = new JSONObject(raw);
            f.enabled = p.optBoolean("enabled", true);
            f.mentions = p.optBoolean("mentions", true);
            f.directMessages = p.optBoolean("directMessages", true);
            JSONObject servers = p.optJSONObject("servers");
            if (servers != null) {
                for (Iterator<String> it = servers.keys(); it.hasNext(); ) {
                    String id = it.next();
                    JSONObject sv = servers.optJSONObject(id);
                    if (sv == null) continue;
                    java.util.HashMap<String, String> m = new java.util.HashMap<>();
                    if (sv.has("channels")) m.put("channels", sv.optString("channels"));
                    if (sv.has("dms")) m.put("dms", sv.optString("dms"));
                    f.servers.put(id, m);
                }
            }
            JSONObject levels = p.optJSONObject("levels");
            if (levels != null) {
                for (Iterator<String> it = levels.keys(); it.hasNext(); ) {
                    String k = it.next();
                    f.levels.put(k, levels.optString(k));
                }
            }
        } catch (JSONException e) {
            Log.w(TAG, "bad push prefs", e);
        }
        return f;
    }

    private static String ok(Object v) {
        try {
            return new JSONObject().put("ok", v == null ? JSONObject.NULL : v).toString();
        } catch (JSONException e) {
            return "{\"err\":\"failed: encoding\"}";
        }
    }

    private static String err(String codeAndMessage) {
        try {
            return new JSONObject().put("err", codeAndMessage).toString();
        } catch (JSONException e) {
            return "{\"err\":\"failed\"}";
        }
    }

    /** Go's entry point (push_android.c). Called off the main thread. */
    public static String call(String op, String arg) {
        Context c = app;
        if (c == null) return err("unsupported: push isn’t ready");
        try {
            switch (op) {
                case "supported":
                    return ok(backend() == null ? "This build has no push (built without Firebase)." : "");
                case "token": {
                    PushBackend b = backend();
                    if (b == null) return err("unsupported: This build has no push (built without Firebase).");
                    if (!NotificationManagerCompat.from(c).areNotificationsEnabled()) {
                        return err("denied: notifications are turned off for Boson");
                    }
                    if (Looper.myLooper() == Looper.getMainLooper()) return err("failed: called on the main thread");
                    return ok(b.token(c));
                }
                case "attest": {
                    PushBackend b = backend();
                    if (b == null) return err("unsupported: This build has no push (built without Firebase).");
                    return ok(b.attest(c, arg));
                }
                case "load":
                    return ok(records(c).getString(arg, ""));
                case "save": {
                    String id = new JSONObject(arg).optString("serverId", "");
                    if (id.isEmpty()) return err("failed: a record without a server");
                    if (!records(c).edit().putString(id, arg).commit()) return err("failed: couldn’t save the push keys");
                    return ok(null);
                }
                case "delete":
                    records(c).edit().remove(arg).commit();
                    return ok(null);
                case "prefs":
                    c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(PREFS_KEY, arg).apply();
                    return ok(null);
                default:
                    return err("failed: unknown op " + op);
            }
        } catch (Exception e) {
            Log.w(TAG, "push " + op + " failed", e);
            String m = e.getMessage();
            return err("failed: " + (m == null ? e.getClass().getSimpleName() : m));
        }
    }
}
