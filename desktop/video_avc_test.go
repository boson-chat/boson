package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

var (
	testSPS = []byte{0x67, 0x42, 0xc0, 0x1e, 0xda, 0x02, 0x80}
	testPPS = []byte{0x68, 0xce, 0x3c, 0x80}
	testIDR = []byte{0x65, 0x88, 0x84, 0x00, 0x33}
	testP   = []byte{0x41, 0x9a, 0x02, 0x04}
	testAUD = []byte{0x09, 0xf0}
)

func annexB(nals ...[]byte) []byte {
	var b []byte
	for i, n := range nals {
		if i%2 == 0 {
			b = append(b, 0, 0, 0, 1) // mix 4- and 3-byte start codes
		} else {
			b = append(b, 0, 0, 1)
		}
		b = append(b, n...)
	}
	return b
}

func TestSplitAnnexB(t *testing.T) {
	got := splitAnnexB(annexB(testAUD, testSPS, testPPS, testIDR))
	want := [][]byte{testAUD, testSPS, testPPS, testIDR}
	if len(got) != len(want) {
		t.Fatalf("%d NALs, want %d", len(got), len(want))
	}
	for i := range want {
		if !bytes.Equal(got[i], want[i]) {
			t.Errorf("NAL %d = %x, want %x", i, got[i], want[i])
		}
	}
	if len(splitAnnexB([]byte{1, 2, 3})) != 0 {
		t.Error("no start code should mean no NALs")
	}
}

// A keyframe: AUD/SPS/PPS leave the data, SPS/PPS become the avcC
// description, slices get 4-byte lengths.
func TestToAVCKeyframe(t *testing.T) {
	f, err := toAVC(annexB(testAUD, testSPS, testPPS, testIDR))
	if err != nil {
		t.Fatal(err)
	}
	if !f.Keyframe {
		t.Error("IDR not seen")
	}
	want := binary.BigEndian.AppendUint32(nil, uint32(len(testIDR)))
	want = append(want, testIDR...)
	if !bytes.Equal(f.Data, want) {
		t.Errorf("data %x, want %x", f.Data, want)
	}
	d := f.Desc
	if len(d) < 11 || d[0] != 1 || d[1] != 0x42 || d[2] != 0xc0 || d[3] != 0x1e || d[4] != 0xff || d[5] != 0xe1 {
		t.Fatalf("avcC header %x", d)
	}
	spsLen := int(binary.BigEndian.Uint16(d[6:]))
	if !bytes.Equal(d[8:8+spsLen], testSPS) || d[8+spsLen] != 1 {
		t.Fatalf("avcC SPS %x", d)
	}
	ppsLen := int(binary.BigEndian.Uint16(d[9+spsLen:]))
	if !bytes.Equal(d[11+spsLen:11+spsLen+ppsLen], testPPS) {
		t.Fatalf("avcC PPS %x", d)
	}
	if got := codecString(d); got != "avc1.42c01e" {
		t.Errorf("codec %q", got)
	}
}

func TestToAVCDelta(t *testing.T) {
	f, err := toAVC(annexB(testP))
	if err != nil {
		t.Fatal(err)
	}
	if f.Keyframe || f.Desc != nil || len(f.Data) != 4+len(testP) {
		t.Fatalf("%+v", f)
	}
	if _, err := toAVC(annexB(testAUD)); err == nil {
		t.Error("an AUD alone has no picture")
	}
	if codecString(nil) != "avc1.42e01f" {
		t.Error("default codec")
	}
}

func TestFrameMsg(t *testing.T) {
	f := avcFrame{Data: []byte{0, 0, 0, 1, 0x65}, Desc: []byte{1, 2, 3}, Keyframe: true}
	b := encodeFrameMsg(7, 2, 1_800_000_000_000_000, f)
	if b[0] != frameVersion || b[1] != frameKey|frameHasDesc {
		t.Fatalf("head %x", b[:2])
	}
	if binary.BigEndian.Uint32(b[2:]) != 7 || binary.BigEndian.Uint32(b[6:]) != 2 ||
		binary.BigEndian.Uint64(b[10:]) != 1_800_000_000_000_000 || binary.BigEndian.Uint16(b[18:]) != 3 {
		t.Fatalf("fields %x", b[:frameHeaderLen])
	}
	if !bytes.Equal(b[frameHeaderLen:frameHeaderLen+3], f.Desc) || !bytes.Equal(b[frameHeaderLen+3:], f.Data) {
		t.Fatalf("body %x", b[frameHeaderLen:])
	}
	if d := encodeFrameMsg(1, 0, 1, avcFrame{Data: []byte{9}}); d[1] != 0 || binary.BigEndian.Uint16(d[18:]) != 0 {
		t.Fatalf("delta flags %x", d[:frameHeaderLen])
	}
}
