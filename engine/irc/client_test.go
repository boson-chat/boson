package irc

import (
	"testing"

	"github.com/lrstanley/girc"
	"github.com/stretchr/testify/assert"
)

func TestNew_RequiresHostname(t *testing.T) {
	_, err := New(Config{Port: 6697, Nick: "alice"})
	assert.ErrorContains(t, err, "hostname")
}

func TestNew_RequiresValidPort(t *testing.T) {
	_, err := New(Config{Hostname: "irc", Port: 0, Nick: "alice"})
	assert.ErrorContains(t, err, "port")

	_, err = New(Config{Hostname: "irc", Port: 99999, Nick: "alice"})
	assert.ErrorContains(t, err, "port")
}

func TestNew_RequiresNick(t *testing.T) {
	_, err := New(Config{Hostname: "irc", Port: 6697})
	assert.ErrorContains(t, err, "nick")
}

func TestNew_DefaultsUserAndRealNameToNick(t *testing.T) {
	c, err := New(Config{Hostname: "irc", Port: 6697, Nick: "alice"})
	assert.NoError(t, err)
	assert.Equal(t, "alice", c.cfg.User)
	assert.Equal(t, "alice", c.cfg.RealName)
}

func TestNew_HonorsExplicitUserAndRealName(t *testing.T) {
	c, err := New(Config{Hostname: "irc", Port: 6697, Nick: "alice", User: "ali", RealName: "Alice Anderson"})
	assert.NoError(t, err)
	assert.Equal(t, "ali", c.cfg.User)
	assert.Equal(t, "Alice Anderson", c.cfg.RealName)
}

func TestTranslate_Privmsg(t *testing.T) {
	e := girc.Event{
		Command: girc.PRIVMSG,
		Source:  &girc.Source{Name: "bob"},
		Params:  []string{"#general", "hello world"},
	}
	got := translate(e)
	assert.Equal(t, "PRIVMSG", got.Kind)
	assert.Equal(t, "bob", got.From)
	assert.Equal(t, "#general", got.Target)
	assert.Equal(t, "hello world", got.Message)
}

func TestTranslate_Notice(t *testing.T) {
	e := girc.Event{
		Command: girc.NOTICE,
		Source:  &girc.Source{Name: "NickServ"},
		Params:  []string{"alice", "You are now identified."},
	}
	got := translate(e)
	assert.Equal(t, "NOTICE", got.Kind)
	assert.Equal(t, "NickServ", got.From)
	assert.Equal(t, "alice", got.Target)
	assert.Equal(t, "You are now identified.", got.Message)
}

func TestTranslate_JoinAndPart(t *testing.T) {
	join := translate(girc.Event{
		Command: girc.JOIN,
		Source:  &girc.Source{Name: "alice"},
		Params:  []string{"#general"},
	})
	assert.Equal(t, "JOIN", join.Kind)
	assert.Equal(t, "alice", join.From)
	assert.Equal(t, "#general", join.Target)

	part := translate(girc.Event{
		Command: girc.PART,
		Source:  &girc.Source{Name: "alice"},
		Params:  []string{"#general"},
	})
	assert.Equal(t, "PART", part.Kind)
}

func TestTranslate_Quit(t *testing.T) {
	got := translate(girc.Event{
		Command: girc.QUIT,
		Source:  &girc.Source{Name: "alice"},
		Params:  []string{"goodbye"},
	})
	assert.Equal(t, "QUIT", got.Kind)
	assert.Equal(t, "alice", got.From)
	assert.Equal(t, "goodbye", got.Message)
}

func TestTranslate_ForwardsHostFromSource(t *testing.T) {
	got := translate(girc.Event{
		Command: girc.PRIVMSG,
		Source:  &girc.Source{Name: "bob", Ident: "b", Host: "user/bob"},
		Params:  []string{"#general", "hi"},
	})
	assert.Equal(t, "user/bob", got.Host)
}

func TestTranslate_AccountTag(t *testing.T) {
	got := translate(girc.Event{
		Command: girc.PRIVMSG,
		Source:  &girc.Source{Name: "bob"},
		Tags:    girc.Tags{"account": "bobaccount"},
		Params:  []string{"#general", "hi"},
	})
	assert.Equal(t, "bobaccount", got.Account)
}

func TestTranslate_ExtendedJoinAccountAndHost(t *testing.T) {
	// extended-join: JOIN <channel> <account> :<realname>
	got := translate(girc.Event{
		Command: girc.JOIN,
		Source:  &girc.Source{Name: "alice", Host: "cloak/alice"},
		Params:  []string{"#general", "aliceacct", "Alice Real"},
	})
	assert.Equal(t, "JOIN", got.Kind)
	assert.Equal(t, "aliceacct", got.Account)
	assert.Equal(t, "cloak/alice", got.Host)

	// Not-identified joiner: "*" normalizes to empty.
	loggedOut := translate(girc.Event{
		Command: girc.JOIN,
		Source:  &girc.Source{Name: "carol"},
		Params:  []string{"#general", "*", "Carol"},
	})
	assert.Equal(t, "", loggedOut.Account)
}

func TestTranslate_WhoReplyHost(t *testing.T) {
	// 352 mynick #chan ident host server nick flags :realname
	got := translate(girc.Event{
		Command: girc.RPL_WHOREPLY,
		Params:  []string{"me", "#general", "b", "user/bob", "irc.x", "bob", "H", "0 Bob"},
	})
	assert.Equal(t, "#general", got.Target)
	assert.Equal(t, "bob", got.From)
	assert.Equal(t, "user/bob", got.Host)
}

func TestTranslate_AccountNotify(t *testing.T) {
	loggedIn := translate(girc.Event{
		Command: "ACCOUNT",
		Source:  &girc.Source{Name: "bob"},
		Params:  []string{"bobaccount"},
	})
	assert.Equal(t, "ACCOUNT", loggedIn.Kind)
	assert.Equal(t, "bob", loggedIn.From)
	assert.Equal(t, "bobaccount", loggedIn.Account)

	loggedOut := translate(girc.Event{
		Command: "ACCOUNT",
		Source:  &girc.Source{Name: "bob"},
		Params:  []string{"*"},
	})
	assert.Equal(t, "", loggedOut.Account)
}

func TestTranslate_ChgHost(t *testing.T) {
	// :nick!user@host CHGHOST <newuser> <newhost>
	got := translate(girc.Event{
		Command: "CHGHOST",
		Source:  &girc.Source{Name: "bob", Host: "old/host"},
		Params:  []string{"newuser", "new/host"},
	})
	assert.Equal(t, "CHGHOST", got.Kind)
	assert.Equal(t, "bob", got.From)
	assert.Equal(t, "new/host", got.Host)
}

func TestTranslate_YoureOper(t *testing.T) {
	got := translate(girc.Event{
		Command: girc.RPL_YOUREOPER,
		Source:  &girc.Source{Name: "irc.boson.chat"},
		Params:  []string{"alice", "You are now an IRC operator"},
	})
	assert.Equal(t, "381", got.Kind)
	assert.True(t, got.IsOper, "381 RPL_YOUREOPER must set IsOper")
	assert.Equal(t, "You are now an IRC operator", got.Message)
}

func TestTranslate_SelfModeOper(t *testing.T) {
	// :server MODE alice +o  — a user-mode grant on our own nick.
	got := translate(girc.Event{
		Command: girc.MODE,
		Source:  &girc.Source{Name: "irc.boson.chat"},
		Params:  []string{"alice", "+o"},
	})
	assert.Equal(t, "alice", got.Target)
	assert.True(t, got.IsOper, "self MODE +o must set IsOper")
}

func TestTranslate_ChannelOpIsNotOper(t *testing.T) {
	// :alice MODE #general +o bob — channel op, NOT an IRC operator.
	got := translate(girc.Event{
		Command: girc.MODE,
		Source:  &girc.Source{Name: "alice"},
		Params:  []string{"#general", "+o", "bob"},
	})
	assert.Equal(t, "#general", got.Target)
	assert.False(t, got.IsOper, "channel +o must NOT set IsOper")
}

func TestTranslate_PlainModeNoOper(t *testing.T) {
	// Self user-mode change that doesn't add +o.
	got := translate(girc.Event{
		Command: girc.MODE,
		Source:  &girc.Source{Name: "irc.boson.chat"},
		Params:  []string{"alice", "+i"},
	})
	assert.False(t, got.IsOper, "+i must not set IsOper")

	// Removing +o is not a grant.
	removed := translate(girc.Event{
		Command: girc.MODE,
		Source:  &girc.Source{Name: "irc.boson.chat"},
		Params:  []string{"alice", "-o"},
	})
	assert.False(t, removed.IsOper, "-o must not set IsOper")
}

func TestTranslate_Welcome(t *testing.T) {
	got := translate(girc.Event{
		Command: girc.RPL_WELCOME,
		Source:  &girc.Source{Name: "irc.libera.chat"},
		Params:  []string{"alice", "Welcome to Libera.Chat, alice"},
	})
	assert.Equal(t, "001", got.Kind, "RPL_WELCOME is numeric 001")
	assert.Equal(t, "Welcome to Libera.Chat, alice", got.Message)
}

func TestTranslate_NamReply(t *testing.T) {
	got := translate(girc.Event{
		Command: girc.RPL_NAMREPLY,
		Source:  &girc.Source{Name: "irc.example"},
		Params:  []string{"alice", "=", "#general", "@op +voice charlie dave"},
	})
	assert.Equal(t, "353", got.Kind, "RPL_NAMREPLY is numeric 353")
	assert.Equal(t, "#general", got.Target)
	assert.Equal(t, "@op +voice charlie dave", got.Message)
}

func TestTranslate_EndOfNames(t *testing.T) {
	got := translate(girc.Event{
		Command: girc.RPL_ENDOFNAMES,
		Source:  &girc.Source{Name: "irc.example"},
		Params:  []string{"alice", "#general", "End of /NAMES list."},
	})
	assert.Equal(t, "366", got.Kind)
	assert.Equal(t, "#general", got.Target)
}

func TestTranslate_Nick(t *testing.T) {
	got := translate(girc.Event{
		Command: girc.NICK,
		Source:  &girc.Source{Name: "oldnick"},
		Params:  []string{"newnick"},
	})
	assert.Equal(t, "NICK", got.Kind)
	assert.Equal(t, "oldnick", got.From)
	assert.Equal(t, "newnick", got.Message)
}

func TestTranslate_Kick(t *testing.T) {
	got := translate(girc.Event{
		Command: girc.KICK,
		Source:  &girc.Source{Name: "kicker"},
		Params:  []string{"#general", "victim", "bye"},
	})
	assert.Equal(t, "KICK", got.Kind)
	assert.Equal(t, "kicker", got.From)
	assert.Equal(t, "#general", got.Target)
	assert.Equal(t, []string{"victim"}, got.Args)
	assert.Equal(t, "bye", got.Message)
}

func TestTranslate_Mode_UserStatus(t *testing.T) {
	got := translate(girc.Event{
		Command: girc.MODE,
		Source:  &girc.Source{Name: "ChanOp"},
		Params:  []string{"#general", "+oo-v", "alice", "bob", "carol"},
	})
	assert.Equal(t, "MODE", got.Kind)
	assert.Equal(t, "ChanOp", got.From)
	assert.Equal(t, "#general", got.Target)
	assert.Equal(t, []string{"+oo-v", "alice", "bob", "carol"}, got.Args)
}

func TestTranslate_DropsNonNumericChatter(t *testing.T) {
	// PING / PONG / other infra commands aren't forwarded to the renderer.
	got := translate(girc.Event{Command: "PING", Params: []string{"server"}})
	assert.Empty(t, got.Kind, "PING should be dropped (empty Event)")
}

func TestTranslate_ForwardsArbitraryNumerics(t *testing.T) {
	// All 3-digit numeric replies flow through with Message + Args set so
	// the renderer can render LUSERS / VERSION / ADMIN / TIME / WHOIS /
	// etc. replies inline in the Advanced panel. The explicit cases
	// elsewhere in translate() handle the few numerics that need
	// structured parsing (welcome, isupport, NAMES, MOTD, ...).
	got := translate(girc.Event{Command: "265", Params: []string{"alice", "Current local users 100"}})
	assert.Equal(t, "265", got.Kind)
	assert.Equal(t, "Current local users 100", got.Message)

	// RPL_LUSERCLIENT (251): mynick :There are X users ...
	got = translate(girc.Event{Command: "251", Params: []string{"alice", "There are 5 users and 0 services on 1 servers"}})
	assert.Equal(t, "251", got.Kind)
	assert.Equal(t, "There are 5 users and 0 services on 1 servers", got.Message)

	// RPL_VERSION (351): mynick versionstring server :flags
	got = translate(girc.Event{Command: "351", Params: []string{"alice", "unrealircd-6.1.2", "irc.example.org", "<comments>"}})
	assert.Equal(t, "351", got.Kind)
	// Args carries the structured fields (mynick is stripped).
	assert.Equal(t, []string{"unrealircd-6.1.2", "irc.example.org", "<comments>"}, got.Args)
}

func TestClient_String(t *testing.T) {
	c, err := New(Config{Hostname: "irc.example", Port: 6697, TLS: true, Nick: "alice"})
	assert.NoError(t, err)
	assert.Equal(t, "alice@irc.example:6697 (tls=true)", c.String())

	c2, err := New(Config{Hostname: "irc.local", Port: 6667, TLS: false, Nick: "bob"})
	assert.NoError(t, err)
	assert.Equal(t, "bob@irc.local:6667 (tls=false)", c2.String())
}

func TestSASLConfig(t *testing.T) {
	assert.Nil(t, saslConfig(nil))
	got := saslConfig(&SASLPlain{User: "alice", Password: "hunter2"})
	plain, ok := got.(*girc.SASLPlain)
	assert.True(t, ok)
	assert.Equal(t, "alice", plain.User)
	assert.Equal(t, "hunter2", plain.Pass)
}

func TestIs421ForListThrottle_MatchesErgoRateLimitedReply(t *testing.T) {
	// Realistic shape Ergo emits when LIST hits the 60s connection-age
	// throttle. Params[0] is our nick (echoed by the server),
	// Params[1] is the rejected command, the trailing param carries
	// the explanation.
	c := &Client{}
	matched := c.is421ForListThrottle(girc.Event{
		Source: &girc.Source{Name: "irc.boson.chat"},
		Params: []string{"Nyan", "LIST", "You must be connected for at least 60 seconds before you can use this command"},
	})
	assert.True(t, matched, "Ergo's LIST rate-limit message should be detected")
}

func TestIs421ForListThrottle_IgnoresUnrelatedUnknownCommand(t *testing.T) {
	// 421 fires for any unknown command. We want only the LIST-rate-
	// limited variant to trigger an auto-retry — a real "FOO is not
	// supported" reply must not start an infinite loop.
	c := &Client{}
	matched := c.is421ForListThrottle(girc.Event{
		Params: []string{"Nyan", "FOO", "Unknown command"},
	})
	assert.False(t, matched, "non-LIST 421 must not be retried")
}

func TestIs421ForListThrottle_IgnoresGenericListNotSupported(t *testing.T) {
	// Some old daemons reply 421 LIST with a generic message — without
	// the "seconds" / "connected" hint we treat it as terminal so we
	// don't retry against a server that genuinely doesn't support LIST.
	c := &Client{}
	matched := c.is421ForListThrottle(girc.Event{
		Params: []string{"Nyan", "LIST", "Unknown command"},
	})
	assert.False(t, matched, "generic LIST-unsupported reply must not be auto-retried")
}

func TestTLSConfigFor(t *testing.T) {
	// No TLS → nil regardless of insecure flag.
	assert.Nil(t, tlsConfigFor(Config{TLS: false, TLSInsecure: true}))
	// TLS but verifying → nil (girc uses its default verified config).
	assert.Nil(t, tlsConfigFor(Config{TLS: true, TLSInsecure: false}))
	// TLS + insecure → skip verify, SNI pinned to the host.
	tc := tlsConfigFor(Config{TLS: true, TLSInsecure: true, Hostname: "znc.example.com"})
	if assert.NotNil(t, tc) {
		assert.True(t, tc.InsecureSkipVerify)
		assert.Equal(t, "znc.example.com", tc.ServerName)
	}
}

func TestNew_WiresServerPassAndTLSConfig(t *testing.T) {
	c, err := New(Config{
		Hostname: "znc.example.com", Port: 6697, TLS: true, TLSInsecure: true,
		Nick: "me", ServerPass: "me/libera:hunter2",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	assert.Equal(t, "me/libera:hunter2", c.girc.Config.ServerPass)
	if assert.NotNil(t, c.girc.Config.TLSConfig) {
		assert.True(t, c.girc.Config.TLSConfig.InsecureSkipVerify)
	}
}

func TestNew_NoServerPassByDefault(t *testing.T) {
	c, err := New(Config{Hostname: "irc.example.org", Port: 6667, Nick: "me"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	assert.Equal(t, "", c.girc.Config.ServerPass)
	assert.Nil(t, c.girc.Config.TLSConfig)
}

func TestNew_NegotiatesChathistoryCaps(t *testing.T) {
	c, err := New(Config{Hostname: "irc.example.org", Port: 6667, Nick: "me"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	caps := c.girc.Config.SupportedCaps
	for _, want := range []string{"batch", "chathistory", "draft/chathistory", "server-time", "znc.in/playback"} {
		if _, ok := caps[want]; !ok {
			t.Errorf("SupportedCaps missing %q", want)
		}
	}
}

func TestTranslate_BatchForwardsParams(t *testing.T) {
	start := translate(girc.Event{
		Command: "BATCH",
		Params:  []string{"+abc", "chathistory", "#general"},
	})
	assert.Equal(t, "BATCH", start.Kind)
	assert.Equal(t, []string{"+abc", "chathistory", "#general"}, start.Args)

	end := translate(girc.Event{Command: "BATCH", Params: []string{"-abc"}})
	assert.Equal(t, []string{"-abc"}, end.Args)
}

func TestTranslate_ForwardsServerTimeAndMsgidTags(t *testing.T) {
	got := translate(girc.Event{
		Command: girc.PRIVMSG,
		Source:  &girc.Source{Name: "bob"},
		Params:  []string{"#general", "hi"},
		Tags:    girc.Tags{"time": "2026-06-13T12:00:00.000Z", "msgid": "abc123"},
	})
	assert.Equal(t, "2026-06-13T12:00:00.000Z", got.Tags["time"])
	assert.Equal(t, "abc123", got.Tags["msgid"])
}
