package com.wails.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The FCM receiver (docs/push.md §2.2, §3.3): the relay forwards each Web
 * Push as a data-only, high-priority message with the encrypted body. This
 * decrypts it with the server's key (BosonPush records), reads the IRC line
 * (PushLine), applies the notification settings (PushFilter) and posts one
 * notification per conversation, grouped per server. Without a key that
 * decrypts it, nothing is shown. Data keys (docs/push-android.md):
 * "payload" (also "p", "body"): the aes128gcm body, base64 or base64url;
 * "mailbox" (also "m", "id"): the mailbox id, to pick the key (else every
 * key is tried: AES-GCM rejects the wrong one).
 */
public class BosonPushService extends FirebaseMessagingService {
    private static final String TAG = "BosonPushService";
    static final String CHANNEL = "boson_push";
    /** BosonVoice.notify's notifications use id 1 with the same tags. */
    private static final int ID = 1;

    private static String first(Map<String, String> d, String... keys) {
        for (String k : keys) {
            String v = d.get(k);
            if (v != null && !v.isEmpty()) return v;
        }
        return "";
    }

    @Override
    public void onMessageReceived(RemoteMessage msg) {
        Map<String, String> data = msg.getData();
        String payload = first(data, "payload", "p", "body");
        if (payload.isEmpty()) return;
        String mailbox = first(data, "mailbox", "m", "id");
        byte[] body;
        try {
            body = PushCrypto.b64(payload);
        } catch (IllegalArgumentException e) {
            return;
        }
        List<JSONObject> recs = BosonPush.allRecords(this);
        List<JSONObject> order = new ArrayList<>();
        for (JSONObject r : recs) if (!mailbox.isEmpty() && mailbox.equals(r.optString("mailbox"))) order.add(r);
        for (JSONObject r : recs) if (!order.contains(r)) order.add(r);
        for (JSONObject r : order) {
            String line;
            try {
                line = new String(PushCrypto.decrypt(body,
                        PushCrypto.b64(r.optString("private")), PushCrypto.b64(r.optString("public")),
                        PushCrypto.b64(r.optString("auth"))), StandardCharsets.UTF_8);
            } catch (Exception e) {
                continue; // not this server's key
            }
            show(this, r.optString("serverId"), r.optString("serverName"), PushLine.parse(line));
            return;
        }
        Log.i(TAG, "a push no key here decrypts: dropped");
    }

    @Override
    public void onNewToken(String token) {
        // The next subscribe (every connect) sends it to the relay
        // (push.go: PATCH /v1/mailboxes/<id>).
    }

    static void show(Context c, String serverId, String serverName, PushLine m) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || serverId.isEmpty()) return;
        if (m.type == PushLine.Type.READ) {
            // Read on another device: take it down.
            nm.cancel(PushLine.tag(serverId, m.target), ID);
            return;
        }
        if (m.type != PushLine.Type.MESSAGE) return; // PING webpush, …
        if (BosonPush.foreground) return; // the page shows its own
        if (!BosonPush.filter(c).shows(m, serverId)) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Messages while Boson is closed", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Mentions and direct messages from the servers you're signed in to");
            nm.createNotificationChannel(ch);
        }
        String tag = PushLine.tag(serverId, m.conversation);
        Intent open = new Intent(c, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(BosonPush.EXTRA_SERVER, serverId)
                .putExtra(BosonPush.EXTRA_TARGET, m.conversation);
        PendingIntent pi = PendingIntent.getActivity(c, tag.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String group = "boson-push:" + serverId;
        String body = m.body();
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(m.title())
                .setContentText(body)
                .setSubText(serverName)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setGroup(group)
                .setContentIntent(pi)
                .setAutoCancel(true);
        try {
            nm.notify(tag, ID, b.build());
            // The server's summary, which the conversations collapse under.
            NotificationCompat.Builder sum = new NotificationCompat.Builder(c, CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle(serverName.isEmpty() ? "Boson" : serverName)
                    .setSubText(serverName)
                    .setGroup(group)
                    .setGroupSummary(true)
                    .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                    .setAutoCancel(true);
            nm.notify(group, ID, sum.build());
        } catch (SecurityException e) {
            Log.w(TAG, "notifications not allowed", e);
        }
    }
}
