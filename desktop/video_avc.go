package main

import (
	"encoding/binary"
	"errors"
)

// H.264 for the webview's WebCodecs VideoDecoder, in AVC form: an avcC
// description (from the keyframe's SPS/PPS) and 4-byte length-prefixed
// NAL units. quicvideo sends Annex B (start codes); WebKitGTK's decoder
// only accepts AVC (it hands GStreamer "stream-format=avc" caps and fails
// on Annex B without a description), and Chromium/WebView2 and
// WKWebView take AVC too, so every platform gets the same format.

const (
	nalIDR = 5
	nalSPS = 7
	nalPPS = 8
	nalAUD = 9
)

// avcFrame is one access unit converted for the webview.
type avcFrame struct {
	Data     []byte // length-prefixed NAL units (no SPS/PPS/AUD)
	Desc     []byte // avcC, when the unit carried SPS and PPS (keyframes)
	Keyframe bool   // contains an IDR slice
}

// splitAnnexB returns the NAL units of an Annex-B byte stream (without
// start codes).
func splitAnnexB(b []byte) [][]byte {
	var out [][]byte
	start := -1
	i := 0
	for i+2 < len(b) {
		if b[i] == 0 && b[i+1] == 0 && (b[i+2] == 1 || (b[i+2] == 0 && i+3 < len(b) && b[i+3] == 1)) {
			sc := 3
			if b[i+2] == 0 {
				sc = 4
			}
			if start >= 0 {
				out = append(out, trimTrailingZeros(b[start:i]))
			}
			i += sc
			start = i
			continue
		}
		i++
	}
	if start >= 0 && start < len(b) {
		out = append(out, b[start:])
	}
	return out
}

// trimTrailingZeros drops zero bytes before the next start code
// (trailing_zero_8bits).
func trimTrailingZeros(nal []byte) []byte {
	for len(nal) > 0 && nal[len(nal)-1] == 0 {
		nal = nal[:len(nal)-1]
	}
	return nal
}

var errNoNAL = errors.New("video: no NAL units")

// toAVC converts an Annex-B access unit.
func toAVC(au []byte) (avcFrame, error) {
	var f avcFrame
	var sps, pps []byte
	n := 0
	for _, nal := range splitAnnexB(au) {
		if len(nal) == 0 {
			continue
		}
		switch nal[0] & 0x1f {
		case nalAUD:
			continue
		case nalSPS:
			sps = nal
			continue
		case nalPPS:
			pps = nal
			continue
		case nalIDR:
			f.Keyframe = true
		}
		f.Data = binary.BigEndian.AppendUint32(f.Data, uint32(len(nal)))
		f.Data = append(f.Data, nal...)
		n++
	}
	if n == 0 {
		return f, errNoNAL
	}
	if sps != nil && pps != nil {
		f.Desc = avcC(sps, pps)
	}
	return f, nil
}

// avcC builds an AVCDecoderConfigurationRecord with one SPS and one PPS
// and 4-byte NAL lengths.
func avcC(sps, pps []byte) []byte {
	if len(sps) < 4 {
		return nil
	}
	b := []byte{1, sps[1], sps[2], sps[3], 0xff, 0xe1}
	b = binary.BigEndian.AppendUint16(b, uint16(len(sps)))
	b = append(b, sps...)
	b = append(b, 1)
	b = binary.BigEndian.AppendUint16(b, uint16(len(pps)))
	return append(b, pps...)
}

// codecString is the WebCodecs codec for an avcC ("avc1.PPCCLL").
func codecString(desc []byte) string {
	if len(desc) < 4 {
		return "avc1.42e01f"
	}
	const hex = "0123456789abcdef"
	s := []byte("avc1.")
	for _, v := range desc[1:4] {
		s = append(s, hex[v>>4], hex[v&15])
	}
	return string(s)
}

// Frame messages on the video WebSocket (binary, big endian):
//
//	u8  version (1)
//	u8  flags: 1 keyframe, 2 has description
//	u32 track id
//	u32 layer
//	u64 capture time, sender's Unix µs
//	u16 description length (0 without one)
//	... description (avcC), then the length-prefixed NAL units
const (
	frameVersion   = 1
	frameKey       = 1
	frameHasDesc   = 2
	frameHeaderLen = 1 + 1 + 4 + 4 + 8 + 2
)

func encodeFrameMsg(trackID, layer uint32, captureUS uint64, f avcFrame) []byte {
	var flags byte
	if f.Keyframe {
		flags |= frameKey
	}
	if len(f.Desc) > 0 {
		flags |= frameHasDesc
	}
	b := make([]byte, 0, frameHeaderLen+len(f.Desc)+len(f.Data))
	b = append(b, frameVersion, flags)
	b = binary.BigEndian.AppendUint32(b, trackID)
	b = binary.BigEndian.AppendUint32(b, layer)
	b = binary.BigEndian.AppendUint64(b, captureUS)
	b = binary.BigEndian.AppendUint16(b, uint16(len(f.Desc)))
	b = append(b, f.Desc...)
	return append(b, f.Data...)
}
