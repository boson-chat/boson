// The iOS voice audio unit (voice_device_ios.m, for voice_device_ios.go).
#include <stdint.h>

// Opens the audio session as a voice call and starts the voice-processing
// I/O unit; speaker picks the loudspeaker over the earpiece. 0 or an
// OSStatus / -1 when the session couldn't start. *what says which step.
int bvStart(int speaker, const char **what);
void bvStop(void);
void bvSetSpeaker(int speaker);
// The current output: 1 speaker, 2 earpiece, 3 headphones, 4 Bluetooth,
// 5 other (routeName in voice_route.go); 0 when not running.
int bvRoute(void);
// 1 while a phone call or Siri has the audio.
int bvInterrupted(void);
