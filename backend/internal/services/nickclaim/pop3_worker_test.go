package nickclaim

import (
	"strings"
	"testing"

	"github.com/emersion/go-message"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Services packages send registration mail in Latin-1 as often as UTF-8.
// go-message only decodes non-UTF-8 charsets once its charset package is
// registered; this guards that import.
func TestReadBody_DecodesLatin1(t *testing.T) {
	cases := map[string]string{
		"single part": "Content-Type: text/plain; charset=iso-8859-1\r\n" +
			"Content-Transfer-Encoding: 8bit\r\n\r\n" +
			"Caf\xe9: /msg NickServ VERIFY REGISTER alice abc123\r\n",
		"multipart": "Content-Type: multipart/alternative; boundary=b\r\n\r\n" +
			"--b\r\nContent-Type: text/plain; charset=ISO-8859-1\r\n\r\n" +
			"Caf\xe9: /msg NickServ VERIFY REGISTER alice abc123\r\n" +
			"--b--\r\n",
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			entity, err := message.Read(strings.NewReader(raw))
			require.NoError(t, err)

			body, err := readBody(entity)
			require.NoError(t, err)
			assert.Contains(t, body, "Café")
			assert.Contains(t, body, "VERIFY REGISTER alice abc123")
		})
	}
}
