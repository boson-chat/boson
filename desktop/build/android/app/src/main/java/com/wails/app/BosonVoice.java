package com.wails.app;

import android.view.OrientationEventListener;
import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.content.ContextCompat;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Voice calls (desktop/voice_android.go): what Go's voice service needs of
 * Android around the audio, which itself is miniaudio on AAudio in Go.
 *
 * <ul>
 *   <li>the RECORD_AUDIO runtime permission, asked on the first join, and
 *   CAMERA, asked when the camera is first turned on in a call;</li>
 *   <li>the call audio mode (MODE_IN_COMMUNICATION), audio focus, and the
 *       route: Bluetooth or wired headset when there is one, else the
 *       loudspeaker or the earpiece as the user picks;</li>
 *   <li>the foreground service with the "In voice" notification (and its
 *       Leave action) while a call is on, so the call and the IRC
 *       connections live on with the app in the background.</li>
 * </ul>
 *
 * Go calls the static methods from its own threads (voice_android.c).
 */
public final class BosonVoice {
    private static final String TAG = "BosonVoice";
    static final int MIC_PERMISSION_REQUEST = 7020;
    static final int CAMERA_PERMISSION_REQUEST = 7021;
    private static final String PREFS = "boson_voice";

    private static volatile Activity activity;
    private static volatile Context app;
    private static AudioManager audio;
    private static final Handler main = new Handler(Looper.getMainLooper());

    private static final Object permLock = new Object();
    private static volatile CountDownLatch permLatch;
    private static volatile boolean permGranted;
    private static int permCode;

    private static final Object lock = new Object();
    private static boolean audioOn;
    private static volatile boolean speaker = true;
    private static volatile boolean focusLost;
    private static AudioFocusRequest focusRequest;
    private static AudioDeviceCallback deviceCallback;

    private BosonVoice() {}

    static native void nativeInit();
    static native void nativeLeave();
    static native void nativeOrientation(int degrees);

    /** From MainActivity.onCreate, once libwails.so is loaded. */
    public static void init(Activity a) {
        activity = a;
        app = a.getApplicationContext();
        audio = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
        try {
            nativeInit();
        } catch (UnsatisfiedLinkError e) {
            Log.w(TAG, "no voice in this build", e);
        }
    }

    // ---- the microphone permission ----

    /**
     * 1 granted, 0 denied, 2 not asked yet. With request=1 shows the system
     * prompt and waits (Go calls this off the main thread) for the answer.
     */
    public static int micPermission(int request) {
        return permission(Manifest.permission.RECORD_AUDIO, "mic_asked", MIC_PERMISSION_REQUEST, request);
    }

    /** The CAMERA permission, for video in calls; answers like micPermission. */
    public static int cameraPermission(int request) {
        return permission(Manifest.permission.CAMERA, "camera_asked", CAMERA_PERMISSION_REQUEST, request);
    }

    private static int permission(String perm, String askedKey, int code, int request) {
        Context c = app;
        if (c == null) return 0;
        if (ContextCompat.checkSelfPermission(c, perm) == PackageManager.PERMISSION_GRANTED) {
            return 1;
        }
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (request == 0) return p.getBoolean(askedKey, false) ? 0 : 2;
        final Activity a = activity;
        if (a == null || Looper.myLooper() == Looper.getMainLooper()) return 0;
        CountDownLatch latch = new CountDownLatch(1);
        synchronized (permLock) {
            permGranted = false;
            permCode = code;
            permLatch = latch;
        }
        a.runOnUiThread(() -> a.requestPermissions(new String[]{perm}, code));
        try {
            latch.await(120, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        p.edit().putBoolean(askedKey, true).apply();
        return permGranted ? 1 : 0;
    }

    /** MainActivity.onRequestPermissionsResult; true when it was ours. */
    public static boolean onPermissionResult(int requestCode, int[] grantResults) {
        if (requestCode != MIC_PERMISSION_REQUEST && requestCode != CAMERA_PERMISSION_REQUEST) return false;
        synchronized (permLock) {
            if (requestCode != permCode) return true;
            permGranted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            CountDownLatch l = permLatch;
            if (l != null) l.countDown();
        }
        return true;
    }

    // ---- camera orientation ----

    private static OrientationEventListener orientation;
    private static int lastOrientation = -1;

    /**
     * 1 while a camera runs: report how the phone is held (rounded to a
     * quarter turn) so a phone on its side sends upright video. The
     * sensor, not the screen's rotation: the picture follows the phone
     * even with rotation locked.
     */
    public static void watchOrientation(int on) {
        main.post(() -> {
            Context c = app;
            if (on != 0 && orientation == null && c != null) {
                orientation = new OrientationEventListener(c) {
                    @Override
                    public void onOrientationChanged(int deg) {
                        if (deg == ORIENTATION_UNKNOWN) return; // flat: keep the last
                        int q = ((deg + 45) / 90 * 90) % 360;
                        if (q != lastOrientation) {
                            lastOrientation = q;
                            nativeOrientation(q);
                        }
                    }
                };
                if (orientation.canDetectOrientation()) orientation.enable();
            } else if (on == 0 && orientation != null) {
                orientation.disable();
                orientation = null;
                lastOrientation = -1;
                nativeOrientation(0);
            }
        });
    }

    // ---- audio mode, focus and route ----

    /** 1 when Go opens the audio device, 0 when it closes it. */
    public static void audioStarted(int on) {
        AudioManager am = audio;
        if (am == null) return;
        synchronized (lock) {
            if ((on == 1) == audioOn) return;
            audioOn = on == 1;
            if (audioOn) {
                focusLost = false;
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                requestFocus(am);
                if (deviceCallback == null) {
                    deviceCallback = new AudioDeviceCallback() {
                        @Override public void onAudioDevicesAdded(AudioDeviceInfo[] added) { route(); }
                        @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) { route(); }
                    };
                    am.registerAudioDeviceCallback(deviceCallback, main);
                }
                applyRoute(am);
            } else {
                if (deviceCallback != null) {
                    am.unregisterAudioDeviceCallback(deviceCallback);
                    deviceCallback = null;
                }
                if (Build.VERSION.SDK_INT >= 31) {
                    am.clearCommunicationDevice();
                } else {
                    am.setSpeakerphoneOn(false);
                }
                abandonFocus(am);
                am.setMode(AudioManager.MODE_NORMAL);
                focusLost = false;
            }
        }
    }

    private static void route() {
        AudioManager am = audio;
        if (am == null) return;
        synchronized (lock) {
            if (audioOn) applyRoute(am);
        }
    }

    private static void requestFocus(AudioManager am) {
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
        focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener(change -> {
                    // A phone call (or another call app) takes the audio:
                    // the voice call says so until it comes back.
                    focusLost = change == AudioManager.AUDIOFOCUS_LOSS
                            || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT;
                    if (change == AudioManager.AUDIOFOCUS_GAIN) route();
                }, main)
                .build();
        am.requestAudioFocus(focusRequest);
    }

    private static void abandonFocus(AudioManager am) {
        if (focusRequest != null) {
            am.abandonAudioFocusRequest(focusRequest);
            focusRequest = null;
        }
    }

    /** 1 loudspeaker, 0 earpiece (a headset wins over both). */
    public static void setSpeaker(int on) {
        speaker = on == 1;
        route();
    }

    // A headset first (Bluetooth, then wired/USB), else speaker or earpiece.
    private static void applyRoute(AudioManager am) {
        if (Build.VERSION.SDK_INT >= 31) {
            List<AudioDeviceInfo> devices = am.getAvailableCommunicationDevices();
            AudioDeviceInfo pick = find(devices, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET);
            if (pick == null) pick = find(devices, AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET);
            if (pick == null) pick = find(devices, speaker ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE);
            if (pick != null) {
                am.setCommunicationDevice(pick);
            } else {
                am.clearCommunicationDevice();
            }
        } else {
            am.setSpeakerphoneOn(speaker && !headset(am));
        }
    }

    private static AudioDeviceInfo find(List<AudioDeviceInfo> devices, int... types) {
        for (int t : types) {
            for (AudioDeviceInfo d : devices) {
                if (d.getType() == t) return d;
            }
        }
        return null;
    }

    private static boolean headset(AudioManager am) {
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            int t = d.getType();
            if (t == AudioDeviceInfo.TYPE_WIRED_HEADSET || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                    || t == AudioDeviceInfo.TYPE_USB_HEADSET || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) {
                return true;
            }
        }
        return false;
    }

    /** Where the sound goes: 1 speaker, 2 earpiece, 3 headphones, 4 Bluetooth, 5 other, 0 unknown. */
    public static int route(int unused) {
        AudioManager am = audio;
        if (am == null || !audioOn) return 0;
        if (Build.VERSION.SDK_INT >= 31) {
            AudioDeviceInfo d = am.getCommunicationDevice();
            if (d == null) return 0;
            switch (d.getType()) {
                case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return 1;
                case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return 2;
                case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                case AudioDeviceInfo.TYPE_USB_HEADSET: return 3;
                case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                case AudioDeviceInfo.TYPE_BLE_HEADSET: return 4;
                default: return 5;
            }
        }
        if (am.isSpeakerphoneOn()) return 1;
        return headset(am) ? 3 : 2;
    }

    /** 1 while a phone call (or another app's call) has the audio. */
    public static int interrupted(int unused) {
        AudioManager am = audio;
        if (am == null || !audioOn) return 0;
        int mode = am.getMode();
        return focusLost || mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_RINGTONE ? 1 : 0;
    }

    // ---- the call: foreground service + notification ----

    public static void callStarted(String room, String server) {
        Context c = app;
        if (c == null) return;
        Intent i = new Intent(c, BosonVoiceService.class)
                .setAction(BosonVoiceService.ACTION_START)
                .putExtra("room", room)
                .putExtra("server", server);
        try {
            ContextCompat.startForegroundService(c, i);
        } catch (RuntimeException e) {
            // Started from the background (shouldn't happen: calls start
            // from a tap), or the OS refused: the call goes on without it.
            Log.w(TAG, "couldn't start the voice service", e);
        }
    }

    public static void callEnded(String unusedA, String unusedB) {
        Context c = app;
        if (c == null) return;
        c.stopService(new Intent(c, BosonVoiceService.class));
    }

    /** The notification's Leave button. */
    static void leave() {
        try {
            nativeLeave();
        } catch (UnsatisfiedLinkError e) {
            Log.w(TAG, "no voice in this build", e);
        }
    }
}
