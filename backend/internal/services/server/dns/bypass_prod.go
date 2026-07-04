//go:build !boson_dev

package dns

import "github.com/rs/zerolog/log"

// SelectVerifier always returns the real three-resolver verifier in
// production builds. The AlwaysSucceedVerifier bypass is not compiled in
// (see bypass_dev.go, guarded by the `boson_dev` tag), so even a mis-set
// SKIP_DNS_VERIFY=true cannot disable domain-ownership proof — we log a
// loud warning and verify for real.
func SelectVerifier(skipDNSVerify bool) Verifier {
	if skipDNSVerify {
		log.Warn().Msg("SKIP_DNS_VERIFY=true ignored: DNS bypass is not compiled into this build; verifying for real")
	}
	return NewVerifier()
}
