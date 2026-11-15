//go:build ios && cgo && !novoiceaudio

// iOS voice audio: one voice-processing I/O unit (kAudioUnitSubType_
// VoiceProcessingIO: Apple's echo canceller, noise suppression and AGC on
// the mic) in a playAndRecord / voiceChat audio session, at 48 kHz mono
// S16 both ways, calling into Go (bosonVoiceCapture, bosonVoicePlayback in
// voice_device_ios.go) from its callbacks.
//
// Interruptions (a phone call, Siri) stop the unit; it starts again when
// they end. Route changes (headphones, Bluetooth, speaker) are followed by
// the unit itself; a media-services reset rebuilds it. Manual reference
// counting, as the rest of the package's Objective-C.

#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#include <stdatomic.h>
#include "voice_device_ios.h"
#include "_cgo_export.h"

// iOS asks for up to 4096 frames per callback with the screen locked.
#define BV_MAX_FRAMES 4096

static AudioUnit bvUnit;
static int16_t bvIn[BV_MAX_FRAMES];
static atomic_int bvRunning;
static atomic_int bvInterruptedFlag;
static atomic_int bvSpeaker = 1;
static id bvObservers[3];

static OSStatus bvInput(void *ref, AudioUnitRenderActionFlags *flags, const AudioTimeStamp *ts,
                        UInt32 bus, UInt32 frames, AudioBufferList *unused) {
    if (frames > BV_MAX_FRAMES) return noErr;
    AudioBufferList abl;
    abl.mNumberBuffers = 1;
    abl.mBuffers[0].mNumberChannels = 1;
    abl.mBuffers[0].mDataByteSize = frames * sizeof(int16_t);
    abl.mBuffers[0].mData = bvIn;
    if (AudioUnitRender(bvUnit, flags, ts, 1, frames, &abl) == noErr) {
        bosonVoiceCapture(bvIn, (int)(abl.mBuffers[0].mDataByteSize / sizeof(int16_t)));
    }
    return noErr;
}

static OSStatus bvOutput(void *ref, AudioUnitRenderActionFlags *flags, const AudioTimeStamp *ts,
                         UInt32 bus, UInt32 frames, AudioBufferList *io) {
    for (UInt32 i = 0; i < io->mNumberBuffers; i++) {
        bosonVoicePlayback((int16_t *)io->mBuffers[i].mData, (int)(io->mBuffers[i].mDataByteSize / sizeof(int16_t)));
    }
    return noErr;
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static AVAudioSessionCategoryOptions bvOptions(int speaker) {
    // Bluetooth headsets (HFP: mic and speaker both) are allowed; without a
    // headset, the loudspeaker or the earpiece.
    AVAudioSessionCategoryOptions o = AVAudioSessionCategoryOptionAllowBluetooth;
    if (speaker) o |= AVAudioSessionCategoryOptionDefaultToSpeaker;
    return o;
}
#pragma clang diagnostic pop

static int bvSession(int speaker, const char **what) {
    AVAudioSession *s = [AVAudioSession sharedInstance];
    NSError *err = nil;
    if (![s setCategory:AVAudioSessionCategoryPlayAndRecord mode:AVAudioSessionModeVoiceChat
                options:bvOptions(speaker) error:&err]) {
        *what = "set the audio session category";
        return -1;
    }
    [s setPreferredSampleRate:48000 error:nil];
    [s setPreferredIOBufferDuration:0.01 error:nil];
    if (![s setActive:YES error:&err]) {
        *what = "activate the audio session";
        return -1;
    }
    return 0;
}

static int bvUnitStart(const char **what) {
    AudioComponentDescription d = {
        .componentType = kAudioUnitType_Output,
        .componentSubType = kAudioUnitSubType_VoiceProcessingIO,
        .componentManufacturer = kAudioUnitManufacturer_Apple,
    };
    AudioComponent c = AudioComponentFindNext(NULL, &d);
    if (c == NULL) { *what = "find the voice audio unit"; return -1; }
    OSStatus st = AudioComponentInstanceNew(c, &bvUnit);
    if (st != noErr) { *what = "create the voice audio unit"; return (int)st; }

    UInt32 one = 1, zero = 0, maxFrames = BV_MAX_FRAMES;
    AudioStreamBasicDescription f = {
        .mSampleRate = 48000,
        .mFormatID = kAudioFormatLinearPCM,
        .mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
        .mBytesPerPacket = 2, .mFramesPerPacket = 1, .mBytesPerFrame = 2,
        .mChannelsPerFrame = 1, .mBitsPerChannel = 16,
    };
    AURenderCallbackStruct in = { .inputProc = bvInput }, out = { .inputProc = bvOutput };
    struct { AudioUnitPropertyID id; AudioUnitScope scope; AudioUnitElement el; const void *v; UInt32 n; const char *what; } props[] = {
        { kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &one, sizeof one, "enable the mic" },
        { kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &one, sizeof one, "enable the speaker" },
        { kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &f, sizeof f, "set the mic format" },
        { kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &f, sizeof f, "set the speaker format" },
        { kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxFrames, sizeof maxFrames, "set the buffer size" },
        { kAudioUnitProperty_ShouldAllocateBuffer, kAudioUnitScope_Output, 1, &zero, sizeof zero, "set the mic buffer" },
        { kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 1, &in, sizeof in, "set the mic callback" },
        { kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &out, sizeof out, "set the speaker callback" },
    };
    for (size_t i = 0; i < sizeof props / sizeof props[0]; i++) {
        st = AudioUnitSetProperty(bvUnit, props[i].id, props[i].scope, props[i].el, props[i].v, props[i].n);
        if (st != noErr) { *what = props[i].what; goto fail; }
    }
    if ((st = AudioUnitInitialize(bvUnit)) != noErr) { *what = "initialize the voice audio unit"; goto fail; }
    if ((st = AudioOutputUnitStart(bvUnit)) != noErr) { *what = "start the voice audio unit"; AudioUnitUninitialize(bvUnit); goto fail; }
    return 0;
fail:
    AudioComponentInstanceDispose(bvUnit);
    bvUnit = NULL;
    return (int)st;
}

static void bvUnitStop(void) {
    if (bvUnit == NULL) return;
    AudioOutputUnitStop(bvUnit);
    AudioUnitUninitialize(bvUnit);
    AudioComponentInstanceDispose(bvUnit);
    bvUnit = NULL;
}

static void bvObserve(void) {
    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
    AVAudioSession *s = [AVAudioSession sharedInstance];
    bvObservers[0] = [[nc addObserverForName:AVAudioSessionInterruptionNotification object:s queue:nil
                                  usingBlock:^(NSNotification *n) {
        NSUInteger type = [n.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
        if (type == AVAudioSessionInterruptionTypeBegan) {
            // The system has stopped the unit; it's ours again when this ends.
            atomic_store(&bvInterruptedFlag, 1);
            return;
        }
        atomic_store(&bvInterruptedFlag, 0);
        if (!atomic_load(&bvRunning)) return;
        // Resume whether or not iOS suggests it: a voice call should come
        // back after a phone call.
        [[AVAudioSession sharedInstance] setActive:YES error:nil];
        if (bvUnit != NULL) AudioOutputUnitStart(bvUnit);
    }] retain];
    bvObservers[1] = [[nc addObserverForName:AVAudioSessionMediaServicesWereResetNotification object:s queue:nil
                                  usingBlock:^(NSNotification *n) {
        // The audio server restarted: every unit and session setting is gone.
        if (!atomic_load(&bvRunning)) return;
        const char *what = NULL;
        bvUnit = NULL;
        if (bvSession(atomic_load(&bvSpeaker), &what) == 0) bvUnitStart(&what);
    }] retain];
    bvObservers[2] = [[nc addObserverForName:AVAudioSessionRouteChangeNotification object:s queue:nil
                                  usingBlock:^(NSNotification *n) {
        // A headset going away mid-call: put the chosen route back (the
        // category options are already right; the unit follows by itself).
        NSUInteger reason = [n.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue];
        if (reason == AVAudioSessionRouteChangeReasonOldDeviceUnavailable && atomic_load(&bvRunning) && atomic_load(&bvSpeaker)) {
            [[AVAudioSession sharedInstance] overrideOutputAudioPort:AVAudioSessionPortOverrideSpeaker error:nil];
        }
    }] retain];
}

static void bvUnobserve(void) {
    for (int i = 0; i < 3; i++) {
        if (bvObservers[i] == nil) continue;
        [[NSNotificationCenter defaultCenter] removeObserver:bvObservers[i]];
        [bvObservers[i] release];
        bvObservers[i] = nil;
    }
}

int bvStart(int speaker, const char **what) {
    @autoreleasepool {
        bvStop();
        atomic_store(&bvSpeaker, speaker);
        int st = bvSession(speaker, what);
        if (st != 0) return st;
        if ((st = bvUnitStart(what)) != 0) {
            [[AVAudioSession sharedInstance] setActive:NO error:nil];
            return st;
        }
        atomic_store(&bvInterruptedFlag, 0);
        atomic_store(&bvRunning, 1);
        bvObserve();
        return 0;
    }
}

void bvStop(void) {
    @autoreleasepool {
        if (!atomic_exchange(&bvRunning, 0)) return;
        bvUnobserve();
        bvUnitStop();
        atomic_store(&bvInterruptedFlag, 0);
        // Let other apps' audio (music) come back.
        [[AVAudioSession sharedInstance] setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
    }
}

void bvSetSpeaker(int speaker) {
    @autoreleasepool {
        atomic_store(&bvSpeaker, speaker);
        if (!atomic_load(&bvRunning)) return;
        AVAudioSession *s = [AVAudioSession sharedInstance];
        [s setCategory:AVAudioSessionCategoryPlayAndRecord mode:AVAudioSessionModeVoiceChat options:bvOptions(speaker) error:nil];
        [s overrideOutputAudioPort:speaker ? AVAudioSessionPortOverrideSpeaker : AVAudioSessionPortOverrideNone error:nil];
    }
}

int bvRoute(void) {
    if (!atomic_load(&bvRunning)) return 0;
    @autoreleasepool {
        AVAudioSessionPortDescription *p = [AVAudioSession sharedInstance].currentRoute.outputs.firstObject;
        if (p == nil) return 0;
        NSString *t = p.portType;
        if ([t isEqualToString:AVAudioSessionPortBuiltInSpeaker]) return 1;
        if ([t isEqualToString:AVAudioSessionPortBuiltInReceiver]) return 2;
        if ([t isEqualToString:AVAudioSessionPortHeadphones] || [t isEqualToString:AVAudioSessionPortUSBAudio]) return 3;
        if ([t isEqualToString:AVAudioSessionPortBluetoothHFP] || [t isEqualToString:AVAudioSessionPortBluetoothA2DP] ||
            [t isEqualToString:AVAudioSessionPortBluetoothLE]) return 4;
        return 5;
    }
}

int bvInterrupted(void) { return atomic_load(&bvInterruptedFlag); }
