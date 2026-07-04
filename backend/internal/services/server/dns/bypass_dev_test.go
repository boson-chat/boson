//go:build boson_dev

package dns_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dnsverify "github.com/boson-chat/boson/backend/internal/services/server/dns"
)

func TestAlwaysSucceedVerifier_AlwaysReturnsMatch(t *testing.T) {
	// Dev-mode bypass — used by the API when SKIP_DNS_VERIFY=true in a
	// boson_dev build. The shape of the returned Report matters: it has
	// to look like a real "matched on all three resolvers" outcome so the
	// rest of the service code path (status transitions, /verify HTTP 200)
	// behaves identically to a successful real verify.
	v := dnsverify.AlwaysSucceedVerifier{}
	report, err := v.Verify(context.Background(), "anything.localhost", "garbage-token", dnsverify.ModeStrict)
	require.NoError(t, err)
	assert.True(t, report.Success)
	for _, provider := range []string{"cloudflare", "google", "quad9"} {
		assert.Equal(t, dnsverify.OutcomeMatch, report.Results[provider].Outcome,
			"bypass verifier must report match on every resolver, got %+v", report.Results[provider])
	}
}

func TestSelectVerifier_DevBuildHonoursSkip(t *testing.T) {
	// In a boson_dev build, SKIP_DNS_VERIFY=true selects the bypass.
	v := dnsverify.SelectVerifier(true)
	_, ok := v.(dnsverify.AlwaysSucceedVerifier)
	assert.True(t, ok, "dev build with skip=true must return AlwaysSucceedVerifier, got %T", v)
}
