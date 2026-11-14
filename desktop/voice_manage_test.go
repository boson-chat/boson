//go:build !ios && !android

package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/boson-chat/quicvoice/client"
	"github.com/boson-chat/quicvoice/gen/controlpb"
)

func TestFetchVoiceRoomsPermissionsAndLocks(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"permissions":{"policy":"founders","can_create":true,"create_scope":"founded_channels","founded_channels":["#boson"]},
"rooms":[{"id":"general","name":"General","kind":"static","parent":null,"owner":null,"position":0,"min_role":"member","speak_role":"member","require_channel_membership":false,"can_manage":false,"can_join":true,"can_speak":true,"participants":[]},
{"id":"boson-game-night","name":"Game Night","kind":"dynamic","parent":"#boson","owner":{"user_id":"usr_456","name":"fred"},"position":1,"created_at":"2026-11-13T21:04:05.123Z","min_role":"voice","speak_role":"op","require_channel_membership":true,"can_manage":true,"can_join":false,"can_speak":false,"participants":[]}]}`))
	}))
	defer srv.Close()
	r := fetchVoiceRooms(context.Background(), srv.Client(), srv.URL, "t")
	if r.Error != "" || len(r.Rooms) != 2 {
		t.Fatalf("%+v", r)
	}
	if p := r.Permissions; !p.CanCreate || p.CreateScope != "founded_channels" || len(p.FoundedChannels) != 1 || p.FoundedChannels[0] != "#boson" {
		t.Errorf("permissions %+v", p)
	}
	g, n := r.Rooms[0], r.Rooms[1]
	if g.Parent != "" || g.Kind != "static" || !g.CanJoin || g.CanManage {
		t.Errorf("general %+v", g)
	}
	if n.Parent != "#boson" || n.Owner == nil || n.Owner.Name != "fred" || n.MinRole != "voice" || n.SpeakRole != "op" ||
		!n.RequireChannelMembership || !n.CanManage || n.CanJoin || n.CanSpeak || n.Position != 1 {
		t.Errorf("game night %+v", n)
	}
}

func TestFetchVoiceRoomsOldServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"rooms":[{"id":"general","participants":[]}]}`))
	}))
	defer srv.Close()
	r := fetchVoiceRooms(context.Background(), srv.Client(), srv.URL, "t")
	if r.Permissions.CanCreate || r.Permissions.CreateScope != "none" {
		t.Errorf("permissions %+v", r.Permissions)
	}
	if g := r.Rooms[0]; !g.CanJoin || !g.CanSpeak || g.CanManage || g.MinRole != "member" {
		t.Errorf("an old server's room should be open: %+v", g)
	}
}

func TestVoiceRoomManagement(t *testing.T) {
	var got []struct {
		method, path, ctype, auth string
		body                      map[string]any
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		got = append(got, struct {
			method, path, ctype, auth string
			body                      map[string]any
		}{r.Method, r.URL.EscapedPath(), r.Header.Get("Content-Type"), r.Header.Get("Authorization"), m})
		switch {
		case r.Method == http.MethodPost && m["name"] == "Taken":
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"a voice channel named \"Taken\" already exists under #boson","code":"conflict"}`))
		case r.Method == http.MethodPost:
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"boson-game-night","name":"Game Night","kind":"dynamic","parent":"#boson","can_manage":true,"can_join":true,"can_speak":true,"participants":[]}`))
		case r.Method == http.MethodPatch:
			w.Header().Set("Retry-After", "5")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":"can't check IRC roles right now","code":"unavailable"}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer srv.Close()
	h := newVoiceHarness(t)
	h.svc.http = srv.Client()
	h.svc.disc.cache["irc.boson.chat"].Voice.URL = srv.URL
	// Loopback voice URLs pass only in dev builds.
	h.svc.dev = true

	name, parent, minRole, req := "Game Night", "#Boson", "voice", true
	c := h.svc.CreateRoom("irc.boson.chat", "tok", VoiceRoomInput{Name: &name, Parent: &parent, MinRole: &minRole, RequireChannelMembership: &req})
	if c.Error != "" || c.Room == nil || c.Room.ID != "boson-game-night" || c.Room.Parent != "#boson" {
		t.Fatalf("create %+v", c)
	}
	if g := got[0]; g.method != "POST" || g.path != "/v1/rooms" || g.ctype != "application/json" || g.auth != "Bearer tok" ||
		g.body["name"] != "Game Night" || g.body["parent"] != "#Boson" || g.body["min_role"] != "voice" || g.body["require_channel_membership"] != true {
		t.Errorf("create request %+v", g)
	}
	taken := "Taken"
	if c := h.svc.CreateRoom("irc.boson.chat", "tok", VoiceRoomInput{Name: &taken}); c.Code != "conflict" || c.Error == "" {
		t.Errorf("conflict %+v", c)
	}
	empty := "  "
	if c := h.svc.CreateRoom("irc.boson.chat", "tok", VoiceRoomInput{Name: &empty}); c.Code != "invalid" {
		t.Errorf("empty name %+v", c)
	}
	pos := 3
	u := h.svc.UpdateRoom("irc.boson.chat", "tok", "boson game/night", VoiceRoomInput{Position: &pos, Parent: &parent})
	if u.Code != "unavailable" || u.RetryAfter != 5 {
		t.Errorf("update %+v", u)
	}
	if g := got[len(got)-1]; g.method != "PATCH" || g.path != "/v1/rooms/boson%20game%2Fnight" || g.body["position"] != float64(3) || g.body["parent"] != nil {
		t.Errorf("patch request %+v", g)
	}
	if d := h.svc.DeleteRoom("irc.boson.chat", "tok", "boson-game-night"); d.Error != "" || d.Room != nil {
		t.Errorf("delete %+v", d)
	}
	if d := h.svc.DeleteRoom("irc.evil.org", "tok", "x"); d.Code != "unavailable_voice" {
		t.Errorf("untrusted server %+v", d)
	}
}

func TestVoiceKickedWhenRoomDeleted(t *testing.T) {
	h := newVoiceHarness(t)
	h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "t"})
	h.conns[0].onCtl(&controlpb.ControlMessage{Msg: &controlpb.ControlMessage_Error{Error: &controlpb.Error{
		Code: controlpb.Error_KICKED, Message: `voice channel "Game Night" was deleted by fred`,
	}}})
	deadline := time.Now().Add(time.Second)
	var st VoiceState
	for time.Now().Before(deadline) {
		if st = h.svc.State(); st.Status == "error" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if st.Status != "error" || st.ErrorKind != "kicked" || st.Error != `Voice channel "Game Night" was deleted by fred.` {
		t.Fatalf("state %+v", st)
	}
	// The hang-up finishes just after the state flips.
	for time.Now().Before(deadline) && !(h.conns[0].isClosed() && !h.audio.isRunning()) {
		time.Sleep(5 * time.Millisecond)
	}
	if !h.conns[0].isClosed() || h.audio.isRunning() {
		t.Error("kicked session not hung up")
	}
	// Joining again works.
	if st := h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "music", Token: "t"}); st.Status != "connected" {
		t.Fatalf("rejoin %+v", st)
	}
}

func TestVoiceListener(t *testing.T) {
	h := newVoiceHarness(t)
	dial := h.svc.dial
	h.svc.dial = func(ctx context.Context, cfg client.Config) (voiceConn, error) {
		c, err := dial(ctx, cfg)
		c.(*fakeConn).state.Participants[0].Role = controlpb.Role_LISTENER
		return c, err
	}
	st := h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "t"})
	if !st.Listener || !st.Participants[0].Self || !st.Participants[0].Listener || !st.Participants[0].Muted || st.Participants[0].Speaking {
		t.Fatalf("listener state %+v", st)
	}
	if st.Participants[1].Listener {
		t.Errorf("alice isn't a listener: %+v", st.Participants[1])
	}
}

func (c *fakeConn) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func (a *fakeAudio) isRunning() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.running
}
