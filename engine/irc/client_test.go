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

func TestTranslate_DropsUninterestingEvents(t *testing.T) {
	// PING and arbitrary numeric replies we don't surface to Electron.
	got := translate(girc.Event{Command: "PING", Params: []string{"server"}})
	assert.Empty(t, got.Kind, "PING should be dropped (empty Event)")

	got = translate(girc.Event{Command: "265", Params: []string{"alice", ":Current local users 100"}})
	assert.Empty(t, got.Kind, "RPL_LOCALUSERS (265) should be dropped")
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
