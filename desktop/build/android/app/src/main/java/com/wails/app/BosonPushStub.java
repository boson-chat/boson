package com.wails.app;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/**
 * Stands in for BosonPushService in the manifest of builds without Firebase
 * (declared disabled, never started; app/build.gradle bosonPushService).
 */
public class BosonPushStub extends Service {
    @Override
    public IBinder onBind(Intent intent) { return null; }
}
