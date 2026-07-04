//go:build !boson_dev

package dns_test

import (
	"testing"

	"github.com/stretchr/testify/assert"

	dnsverify "github.com/boson-chat/boson/backend/internal/services/server/dns"
)

func TestSelectVerifier_ProdIgnoresSkip(t *testing.T) {
	// The whole point of the build-tag split: in a production build,
	// SKIP_DNS_VERIFY=true must NOT yield a bypass. SelectVerifier returns
	// the same concrete type as the real NewVerifier(), never an
	// always-succeed stub (which isn't even compiled into this build).
	withSkip := dnsverify.SelectVerifier(true)
	assert.NotNil(t, withSkip)
	assert.IsType(t, dnsverify.NewVerifier(), withSkip,
		"production build must return the real verifier regardless of SKIP_DNS_VERIFY, got %T", withSkip)
}
