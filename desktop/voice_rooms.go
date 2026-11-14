//go:build !ios && !android

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// The voice server's room list: GET {voice.url}/v1/rooms with a voice token.

const (
	voiceRoomsTimeout = 5 * time.Second
	voiceRoomsMax     = 1 << 20
)

// VoiceRoom is a voice channel and who's in it. Servers before quicvoice
// 1.5 send only id, name and participants: the rest then reads as an
// unlocked top-level room nobody may manage.
type VoiceRoom struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// static (the server's config), dynamic (made through the API) or adhoc.
	Kind string `json:"kind"`
	// The IRC channel it sits under (casefolded, "#boson"); "" for none.
	Parent    string          `json:"parent"`
	Owner     *VoiceRoomOwner `json:"owner,omitempty"`
	Position  int             `json:"position"`
	CreatedAt string          `json:"createdAt,omitempty"`
	MinRole   string          `json:"minRole"`
	SpeakRole string          `json:"speakRole"`
	// Must also be in the parent IRC channel to join.
	RequireChannelMembership bool                   `json:"requireChannelMembership"`
	CanManage                bool                   `json:"canManage"`
	CanJoin                  bool                   `json:"canJoin"`
	CanSpeak                 bool                   `json:"canSpeak"`
	Participants             []VoiceRoomParticipant `json:"participants"`
}

type VoiceRoomOwner struct {
	UserID string `json:"userId"`
	Name   string `json:"name"`
}

type VoiceRoomParticipant struct {
	SessionID int    `json:"sessionId"`
	UserID    string `json:"userId"`
	Name      string `json:"name"`
	Muted     bool   `json:"muted"`
	Deafened  bool   `json:"deafened"`
	Speaking  bool   `json:"speaking"`
}

// VoiceRoomPermissions: whether (and where) the caller may make rooms.
// CreateScope: "any", "founded_channels" (only under FoundedChannels) or
// "none".
type VoiceRoomPermissions struct {
	Policy          string   `json:"policy"`
	CanCreate       bool     `json:"canCreate"`
	CreateScope     string   `json:"createScope"`
	FoundedChannels []string `json:"foundedChannels"`
}

// VoiceRoomsResult is Rooms' answer. ErrorKind: "token" (the voice server
// refused the token), "unavailable" (no voice for this server, or no room
// list yet), "unreachable", "server".
type VoiceRoomsResult struct {
	Rooms       []VoiceRoom          `json:"rooms"`
	Permissions VoiceRoomPermissions `json:"permissions"`
	Error       string               `json:"error,omitempty"`
	ErrorKind   string               `json:"errorKind,omitempty"`
}

type roomWire struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	Kind   string  `json:"kind"`
	Parent *string `json:"parent"`
	Owner  *struct {
		UserID string `json:"user_id"`
		Name   string `json:"name"`
	} `json:"owner"`
	Position                 int    `json:"position"`
	CreatedAt                string `json:"created_at"`
	MinRole                  string `json:"min_role"`
	SpeakRole                string `json:"speak_role"`
	RequireChannelMembership bool   `json:"require_channel_membership"`
	CanManage                bool   `json:"can_manage"`
	CanJoin                  *bool  `json:"can_join"`
	CanSpeak                 *bool  `json:"can_speak"`
	Participants             []struct {
		SessionID int    `json:"session_id"`
		UserID    string `json:"user_id"`
		Name      string `json:"name"`
		Muted     bool   `json:"muted"`
		Deafened  bool   `json:"deafened"`
		Speaking  bool   `json:"speaking"`
	} `json:"participants"`
}

type roomsWire struct {
	Permissions *struct {
		Policy          string   `json:"policy"`
		CanCreate       bool     `json:"can_create"`
		CreateScope     string   `json:"create_scope"`
		FoundedChannels []string `json:"founded_channels"`
	} `json:"permissions"`
	Rooms []roomWire `json:"rooms"`
}

func (r roomWire) room() VoiceRoom {
	room := VoiceRoom{
		ID: r.ID, Name: r.Name, Kind: r.Kind, Position: r.Position, CreatedAt: r.CreatedAt,
		MinRole: r.MinRole, SpeakRole: r.SpeakRole, RequireChannelMembership: r.RequireChannelMembership,
		CanManage: r.CanManage, CanJoin: r.CanJoin == nil || *r.CanJoin, CanSpeak: r.CanSpeak == nil || *r.CanSpeak,
		Participants: make([]VoiceRoomParticipant, 0, len(r.Participants)),
	}
	if room.Name == "" {
		room.Name = r.ID
	}
	if room.Kind == "" {
		room.Kind = "static"
	}
	if room.MinRole == "" {
		room.MinRole = "member"
	}
	if room.SpeakRole == "" {
		room.SpeakRole = "member"
	}
	if r.Parent != nil {
		room.Parent = *r.Parent
	}
	if r.Owner != nil {
		room.Owner = &VoiceRoomOwner{UserID: r.Owner.UserID, Name: r.Owner.Name}
	}
	for _, p := range r.Participants {
		room.Participants = append(room.Participants, VoiceRoomParticipant{
			SessionID: p.SessionID, UserID: p.UserID, Name: p.Name,
			Muted: p.Muted, Deafened: p.Deafened, Speaking: p.Speaking,
		})
	}
	return room
}

func fetchVoiceRooms(ctx context.Context, hc *http.Client, baseURL, token string) VoiceRoomsResult {
	ctx, cancel := context.WithTimeout(ctx, voiceRoomsTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/rooms", nil)
	if err != nil {
		return VoiceRoomsResult{Error: err.Error(), ErrorKind: "server"}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return VoiceRoomsResult{Error: "Couldn't reach the voice server.", ErrorKind: "unreachable"}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, voiceRoomsMax+1))
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return VoiceRoomsResult{Error: "The voice server didn't accept your sign-in.", ErrorKind: "token"}
	case resp.StatusCode == http.StatusNotFound:
		return VoiceRoomsResult{Error: "This voice server doesn't list its channels yet.", ErrorKind: "unavailable"}
	case resp.StatusCode != http.StatusOK:
		return VoiceRoomsResult{Error: fmt.Sprintf("The voice server answered %d.", resp.StatusCode), ErrorKind: "server"}
	case err != nil || len(body) > voiceRoomsMax:
		return VoiceRoomsResult{Error: "The voice server's answer was cut short.", ErrorKind: "server"}
	}
	var w roomsWire
	if err := json.Unmarshal(body, &w); err != nil {
		return VoiceRoomsResult{Error: "The voice server sent something unexpected.", ErrorKind: "server"}
	}
	out := VoiceRoomsResult{
		Rooms:       make([]VoiceRoom, 0, len(w.Rooms)),
		Permissions: VoiceRoomPermissions{CreateScope: "none", FoundedChannels: []string{}},
	}
	if p := w.Permissions; p != nil {
		out.Permissions = VoiceRoomPermissions{
			Policy: p.Policy, CanCreate: p.CanCreate, CreateScope: p.CreateScope, FoundedChannels: p.FoundedChannels,
		}
		if out.Permissions.CreateScope == "" {
			out.Permissions.CreateScope = "none"
		}
		if out.Permissions.FoundedChannels == nil {
			out.Permissions.FoundedChannels = []string{}
		}
	}
	for _, r := range w.Rooms {
		if r.ID == "" {
			continue
		}
		out.Rooms = append(out.Rooms, r.room())
	}
	return out
}

// ---- managing rooms: POST/PATCH/DELETE /v1/rooms ----

// VoiceRoomInput is a new room, or the fields of one to change (nil: keep).
type VoiceRoomInput struct {
	Name                     *string `json:"name,omitempty"`
	Parent                   *string `json:"parent,omitempty"`
	Position                 *int    `json:"position,omitempty"`
	MinRole                  *string `json:"minRole,omitempty"`
	SpeakRole                *string `json:"speakRole,omitempty"`
	RequireChannelMembership *bool   `json:"requireChannelMembership,omitempty"`
}

// VoiceRoomChange is the answer to a create, update or delete. Code is the
// voice server's error code (invalid, forbidden, static_room, limit,
// not_found, conflict, unavailable, unauthorized) or unreachable / server;
// Error is a sentence for the user.
type VoiceRoomChange struct {
	Room       *VoiceRoom `json:"room,omitempty"`
	Error      string     `json:"error,omitempty"`
	Code       string     `json:"code,omitempty"`
	RetryAfter int        `json:"retryAfter,omitempty"`
}

func (in VoiceRoomInput) wire(create bool) map[string]any {
	m := map[string]any{}
	if in.Name != nil {
		m["name"] = strings.TrimSpace(*in.Name)
	}
	if create && in.Parent != nil && *in.Parent != "" {
		m["parent"] = *in.Parent
	}
	if !create && in.Position != nil {
		m["position"] = *in.Position
	}
	if in.MinRole != nil {
		m["min_role"] = *in.MinRole
	}
	if in.SpeakRole != nil {
		m["speak_role"] = *in.SpeakRole
	}
	if in.RequireChannelMembership != nil {
		m["require_channel_membership"] = *in.RequireChannelMembership
	}
	return m
}

func changeVoiceRoom(ctx context.Context, hc *http.Client, method, u, token string, body any) VoiceRoomChange {
	ctx, cancel := context.WithTimeout(ctx, voiceRoomsTimeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return VoiceRoomChange{Error: err.Error(), Code: "server"}
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return VoiceRoomChange{Error: err.Error(), Code: "server"}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := hc.Do(req)
	if err != nil {
		return VoiceRoomChange{Error: "Couldn't reach the voice server.", Code: "unreachable"}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, voiceRoomsMax+1))
	if err != nil || len(raw) > voiceRoomsMax {
		return VoiceRoomChange{Error: "The voice server's answer was cut short.", Code: "server"}
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if resp.StatusCode == http.StatusNoContent || len(bytes.TrimSpace(raw)) == 0 {
			return VoiceRoomChange{}
		}
		var w roomWire
		if err := json.Unmarshal(raw, &w); err != nil || w.ID == "" {
			return VoiceRoomChange{Error: "The voice server sent something unexpected.", Code: "server"}
		}
		r := w.room()
		return VoiceRoomChange{Room: &r}
	}
	var e struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	_ = json.Unmarshal(raw, &e)
	out := VoiceRoomChange{Error: e.Error, Code: e.Code}
	if out.Code == "" {
		switch resp.StatusCode {
		case http.StatusBadRequest, http.StatusUnsupportedMediaType:
			out.Code = "invalid"
		case http.StatusUnauthorized:
			out.Code = "unauthorized"
		case http.StatusForbidden:
			out.Code = "forbidden"
		case http.StatusNotFound:
			out.Code = "not_found"
		case http.StatusConflict:
			out.Code = "conflict"
		case http.StatusServiceUnavailable:
			out.Code = "unavailable"
		case http.StatusMethodNotAllowed:
			// A voice server from before room management.
			out.Code = "unsupported"
		default:
			out.Code = "server"
		}
	}
	if out.Error == "" {
		out.Error = fmt.Sprintf("The voice server answered %d.", resp.StatusCode)
	}
	if ra, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && ra > 0 {
		out.RetryAfter = ra
	}
	return out
}

// voiceTrusted: voice may be used with the boson account the app signs in
// to only when the server's auth service is that one, and its voice server
// is under the auth service's domain (auth.boson.chat → *.boson.chat). A
// server can't then collect boson voice tokens by pointing its boson.json
// at our auth service. Dev builds also accept loopback voice servers.
func voiceTrusted(info *VoiceInfo, authBase string, dev bool) bool {
	if info == nil {
		return false
	}
	want, err := cleanBaseURL(authBase, dev)
	if err != nil || info.AuthURL != want {
		return false
	}
	au, _ := url.Parse(want)
	authHost := au.Hostname()
	authDomain := voiceDomain(authHost)
	under := func(host string) bool {
		host = strings.ToLower(host)
		if dev && isLoopbackHost(host) {
			return true
		}
		return authDomain != "" && (host == authDomain || strings.HasSuffix(host, "."+authDomain))
	}
	addrHost, _, err := net.SplitHostPort(info.Addr)
	if err != nil {
		return false
	}
	vu, err := url.Parse(info.URL)
	if err != nil {
		return false
	}
	return under(addrHost) && under(vu.Hostname())
}

func isLoopbackHost(h string) bool {
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}
