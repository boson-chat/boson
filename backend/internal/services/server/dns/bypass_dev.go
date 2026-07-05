//go:build boson_dev

package dns

import "context"

// AlwaysSucceedVerifier is the dev-only short-circuit. It returns a
// "matched on all configured resolvers" Report for every call so the
// caller never has to issue a real DNS query — useful when registering a
// server against a hostname you don't actually own (e.g. localhost / a
// LAN address during dev).
//
// It is compiled ONLY into `boson_dev` builds (e.g. `make run`), never
// into the production binary, so it cannot be reached in a shipped build.
type AlwaysSucceedVerifier struct{}

func (AlwaysSucceedVerifier) Verify(_ context.Context, _, _ string, _ Mode) (Report, error) {
	return Report{
		Success: true,
		Results: map[string]Result{
			"cloudflare": {Outcome: OutcomeMatch, Detail: "dev-mode bypass"},
			"google":     {Outcome: OutcomeMatch, Detail: "dev-mode bypass"},
			"quad9":      {Outcome: OutcomeMatch, Detail: "dev-mode bypass"},
		},
	}, nil
}

// SelectVerifier honours SKIP_DNS_VERIFY in dev builds: when set, the
// bypass is returned so local registrations against un-owned hostnames
// succeed without a real TXT record.
func SelectVerifier(skipDNSVerify bool) Verifier {
	if skipDNSVerify {
		return AlwaysSucceedVerifier{}
	}
	return NewVerifier()
}
