package main

import (
	"encoding/json"
	"strings"
)

// FederationInfo is a boson.json's federation block (federated sign-in,
// spec v1 §1): the network's issuer and the endpoints a home server hands
// out identity assertions on and a remote server signs them in on. The
// renderer offers "Continue as alice@home" from it (modules/netauth/
// federation.ts). Domain is where the document was found (the identity's
// home domain), filled in by discovery.
type FederationInfo struct {
	Version           int    `json:"version"`
	Issuer            string `json:"issuer"`
	JWKSURI           string `json:"jwks_uri,omitempty"`
	AssertionEndpoint string `json:"assertion_endpoint,omitempty"`
	LoginEndpoint     string `json:"login_endpoint,omitempty"`
	Accepts           string `json:"accepts"`
	Domain            string `json:"domain,omitempty"`
}

var federationModes = map[string]bool{"directory": true, "open": true, "allowlist": true, "off": true}

// parseWellKnownFederation reads a boson.json's federation block; nil when
// it's absent or invalid (any endpoint that isn't an https URL, an unknown
// version or mode). Each endpoint must be on the issuer's origin: the app
// sends the home access token to the assertion endpoint, and the API proxy
// only reaches the network's own auth origin.
func parseWellKnownFederation(body []byte, allowHTTP bool) *FederationInfo {
	var doc struct {
		Version    int             `json:"version"`
		Federation *FederationInfo `json:"federation"`
	}
	if json.Unmarshal(body, &doc) != nil || doc.Version != 1 || doc.Federation == nil {
		return nil
	}
	return cleanFederation(doc.Federation, allowHTTP)
}

// cleanFederation validates f (also a cached copy read back from disk).
func cleanFederation(f *FederationInfo, allowHTTP bool) *FederationInfo {
	if f == nil || f.Version != 1 {
		return nil
	}
	accepts := strings.ToLower(strings.TrimSpace(f.Accepts))
	if accepts == "" {
		accepts = "off"
	}
	if !federationModes[accepts] {
		return nil
	}
	issuer, err := cleanBaseURL(strings.TrimSpace(f.Issuer), allowHTTP)
	if err != nil {
		return nil
	}
	origin := originOf(issuer)
	same := func(raw string) (string, bool) {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			return "", true
		}
		u, err := cleanBaseURL(raw, allowHTTP)
		if err != nil || originOf(u) != origin {
			return "", false
		}
		return u, true
	}
	out := &FederationInfo{Version: 1, Issuer: issuer, Accepts: accepts, Domain: f.Domain}
	var ok bool
	if out.JWKSURI, ok = same(f.JWKSURI); !ok {
		return nil
	}
	if out.AssertionEndpoint, ok = same(f.AssertionEndpoint); !ok {
		return nil
	}
	if out.LoginEndpoint, ok = same(f.LoginEndpoint); !ok {
		return nil
	}
	return out
}

// withDomain is f (a copy) naming the domain its document came from.
func (f *FederationInfo) withDomain(domain string) *FederationInfo {
	if f == nil {
		return nil
	}
	c := *f
	c.Domain = strings.ToLower(domain)
	return &c
}
