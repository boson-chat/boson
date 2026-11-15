package com.wails.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * The foreground service (type microphone) that runs while a voice call is
 * on (BosonVoice.callStarted / callEnded): it keeps the process — the call,
 * and the IRC connections with it — alive with the app in the background,
 * and keeps the microphone usable there. Its ongoing notification says
 * "In voice: #room" and has a Leave action.
 */
public class BosonVoiceService extends android.app.Service {
    static final String ACTION_START = "chat.boson.app.VOICE_START";
    static final String ACTION_LEAVE = "chat.boson.app.VOICE_LEAVE";
    private static final String TAG = "BosonVoiceService";
    private static final String CHANNEL_ID = "boson_voice";
    private static final int NOTIFICATION_ID = 0x766F; // "vo"

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_LEAVE.equals(intent.getAction())) {
            // Go hangs up, then stops this service (callEnded).
            BosonVoice.leave();
            return START_NOT_STICKY;
        }
        String room = intent != null ? intent.getStringExtra("room") : null;
        String server = intent != null ? intent.getStringExtra("server") : null;

        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Voice calls", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while you're in a voice channel");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }

        int piFlags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent open = null;
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            open = PendingIntent.getActivity(this, 0, launch, piFlags);
        }
        PendingIntent leave = PendingIntent.getService(this, 1,
                new Intent(this, BosonVoiceService.class).setAction(ACTION_LEAVE), piFlags);

        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle("In voice: " + (room == null || room.isEmpty() ? "voice channel" : room))
                .setContentText(server == null ? "" : server)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setOngoing(true)
                .setSilent(true)
                .setContentIntent(open)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Leave", leave)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (RuntimeException e) {
            // No mic permission, or started from the background.
            Log.w(TAG, "couldn't run in the foreground", e);
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
