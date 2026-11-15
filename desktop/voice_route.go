package main

// routeName turns the phone shells' route codes (BosonVoice.java on
// Android, voice_device_ios.m on iOS) into VoiceState.Route.
func routeName(code int) string {
	switch code {
	case 1:
		return "speaker"
	case 2:
		return "earpiece"
	case 3:
		return "headphones"
	case 4:
		return "bluetooth"
	case 5:
		return "other"
	default:
		return ""
	}
}
