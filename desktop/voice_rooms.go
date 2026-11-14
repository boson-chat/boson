//go:build !ios && !android

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// The voice server's room list: GET {voice.url}/v1/rooms with a voice token.

const (
	voiceRoomsTimeout = 5 * time.Second
	voiceRoomsMax     = 1 << 20
)

// VoiceRoom is a voice channel and who's in it.
type VoiceRoom struct {
	ID           string                 `json:"id"`
	Name         string                 `json:"name"`
	Participants []VoiceRoomParticipant `json:"participants"`
}

type VoiceRoomParticipant struct {
	SessionID int    `json:"sessionId"`
	UserID    string `json:"userId"`
	Name      string `json:"name"`
	Muted     bool   `json:"muted"`
	Deafened  bool   `json:"deafened"`
	Speaking  bool   `json:"speaking"`
}

// VoiceRoomsResult is Rooms' answer. ErrorKind: "token" (the voice server
// refused the token), "unavailable" (no voice for this server, or no room
// list yet), "unreachable", "server".
type VoiceRoomsResult struct {
	Rooms     []VoiceRoom `json:"rooms"`
	Error     string      `json:"error,omitempty"`
	ErrorKind string      `json:"errorKind,omitempty"`
}

type roomsWire struct {
	Rooms []struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		Participants []struct {
			SessionID int    `json:"session_id"`
			UserID    string `json:"user_id"`
			Name      string `json:"name"`
			Muted     bool   `json:"muted"`
			Deafened  bool   `json:"deafened"`
			Speaking  bool   `json:"speaking"`
		} `json:"participants"`
	} `json:"rooms"`
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
	out := VoiceRoomsResult{Rooms: make([]VoiceRoom, 0, len(w.Rooms))}
	for _, r := range w.Rooms {
		if r.ID == "" {
			continue
		}
		room := VoiceRoom{ID: r.ID, Name: r.Name, Participants: make([]VoiceRoomParticipant, 0, len(r.Participants))}
		if room.Name == "" {
			room.Name = r.ID
		}
		for _, p := range r.Participants {
			room.Participants = append(room.Participants, VoiceRoomParticipant{
				SessionID: p.SessionID, UserID: p.UserID, Name: p.Name,
				Muted: p.Muted, Deafened: p.Deafened, Speaking: p.Speaking,
			})
		}
		out.Rooms = append(out.Rooms, room)
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
