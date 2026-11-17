package main

import (
	"time"

	"github.com/boson-chat/quicvoice/wire"
)

// A screen share's sound (quicvideo SCREEN_AUDIO; quicvideo's
// docs/screen-audio.md) plays through the voice engine, as a stream of its
// own next to the voices: its own jitter buffer, gain and playout delay,
// and deafen, the output device and phones' audio routes apply as they do
// to voices. The engine keys streams by voice session id, so each share's
// sound gets an id no one in the call has, from the top of the range
// (the voice server hands ids out from the bottom).
//
// Its timestamps come from the capture clock: the sharer stamps each
// 20 ms Opus frame with its first sample's capture time (exactly 20 ms
// apart), so the engine's 48 kHz timestamp is capture µs × 48 / 1000 and
// the sequence number capture µs / 20 ms. A dropped group is a gap in
// both, which the engine conceals like a voice's lost packets. And which
// capture time reaches the speaker when is the screen video's lip-sync
// offset (shareSoundOffset).

const (
	shareSoundFirstSID = 0xFFFF
	shareSoundLastSID  = 0xFF00
	// shareSoundGap: a pause this long starts a new spurt (the jitter
	// buffer re-syncs instead of waiting out the gap).
	shareSoundGap = 100 * time.Millisecond
)

type shareSound struct {
	sess   *voiceSession // the voice session its id was picked in
	sid    uint16
	lastUS int64 // the last frame's capture time
	gain   float32
}

// playShareSound plays one frame of a screen share's sound (track: its
// SCREEN_AUDIO track) at gain (0..2). Dropped when not in a voice call.
func (s *VoiceService) playShareSound(track uint32, captureUS uint64, payload []byte, gain float32) {
	s.mu.Lock()
	sess, a := s.sess, s.audio
	if sess == nil || a == nil {
		s.mu.Unlock()
		return
	}
	if s.sounds == nil {
		s.sounds = map[uint32]*shareSound{}
	}
	snd := s.sounds[track]
	fresh := false
	if snd == nil || snd.sess != sess || sess.members[snd.sid] != nil {
		// New, from an earlier call, or someone joined with its id.
		old := snd
		sid, ok := s.freeSoundSIDLocked(sess)
		if !ok {
			s.mu.Unlock()
			return
		}
		snd = &shareSound{sess: sess, sid: sid, gain: gain}
		s.sounds[track] = snd
		fresh = true
		if old != nil && old.sess == sess {
			defer a.RemoveSender(old.sid)
		}
	}
	us := int64(captureUS)
	flags := uint8(0)
	if fresh || us-snd.lastUS > shareSoundGap.Microseconds() || us < snd.lastUS {
		flags = wire.FlagStart
	}
	snd.lastUS = us
	sid, g := snd.sid, snd.gain
	s.mu.Unlock()
	if fresh {
		a.SetUserVolume(sid, g)
	}
	a.HandleAudio(wire.Downlink{SessionID: sid, Audio: wire.Audio{
		Flags:     flags,
		Voice:     true,
		Level:     wire.LevelSilence,
		Seq:       uint16(captureUS / 20_000),
		Timestamp: uint32(captureUS * 48 / 1000),
		Payload:   payload,
	}})
}

// freeSoundSIDLocked picks a stream id no member and no other share's
// sound has.
func (s *VoiceService) freeSoundSIDLocked(sess *voiceSession) (uint16, bool) {
	used := map[uint16]bool{}
	for _, o := range s.sounds {
		if o.sess == sess {
			used[o.sid] = true
		}
	}
	for sid := uint32(shareSoundFirstSID); sid >= shareSoundLastSID; sid-- {
		if !used[uint16(sid)] && sess.members[uint16(sid)] == nil {
			return uint16(sid), true
		}
	}
	return 0, false
}

// removeShareSound stops a share's sound (unsubscribed, or the share
// ended).
func (s *VoiceService) removeShareSound(track uint32) {
	s.mu.Lock()
	snd, a := s.sounds[track], s.audio
	delete(s.sounds, track)
	current := snd != nil && snd.sess == s.sess
	s.mu.Unlock()
	if current && a != nil {
		a.RemoveSender(snd.sid)
		a.SetUserVolume(snd.sid, 1) // gains outlive streams in the engine
	}
}

// setShareSoundGain sets how loud a share's sound is for us (0 = muted,
// 1 = as sent, up to 2).
func (s *VoiceService) setShareSoundGain(track uint32, gain float32) {
	s.mu.Lock()
	snd, a := s.sounds[track], s.audio
	live := snd != nil && snd.sess == s.sess
	if snd != nil {
		snd.gain = gain
	}
	s.mu.Unlock()
	if live && a != nil {
		a.SetUserVolume(snd.sid, gain)
	}
}

// shareSoundOffset is lip sync for the share's picture: the local wall
// clock offset (µs) at which the frame captured at C should be shown
// (C + offset), so it's on screen when the sound captured with it plays.
func (s *VoiceService) shareSoundOffset(track uint32) (int64, bool) {
	s.mu.Lock()
	snd, a := s.sounds[track], s.audio
	ok := snd != nil && snd.sess == s.sess
	var sid uint16
	var lastUS int64
	if ok {
		sid, lastUS = snd.sid, snd.lastUS
	}
	s.mu.Unlock()
	ps, isPS := a.(playoutSource)
	if !ok || !isPS {
		return 0, false
	}
	ts, localUS, ok := ps.Playout(sid)
	if !ok {
		return 0, false
	}
	// The 48 kHz timestamp wraps every 24.8 h: unwrap it next to the last
	// frame's.
	base := lastUS * 48 / 1000
	full := base + int64(int32(ts-uint32(base)))
	return localUS - full*1000/48, true
}

// setShareSoundDelay delays a share's sound by d: lip sync when its
// picture arrives later than the sound would play.
func (s *VoiceService) setShareSoundDelay(track uint32, d time.Duration) {
	s.mu.Lock()
	snd, a := s.sounds[track], s.audio
	live := snd != nil && snd.sess == s.sess
	s.mu.Unlock()
	if pd, ok := a.(playoutDelayer); ok && live {
		pd.SetPlayoutDelay(snd.sid, d)
	}
}
