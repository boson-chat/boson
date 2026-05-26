// typingbot connects to a local IRC server (default: ergo on localhost:6667),
// joins a channel, and exercises the Boson client's notification UI:
//
//	make ergo-up
//	go run ./engine/cmd/typingbot                  # default
//	go run ./engine/cmd/typingbot --mention=james  # also mention you by nick
//	# now connect Boson to localhost:6667, /join #boson-typing-test
//	# you should see:
//	#   - "tester is typing…" between message list and input bar
//	#   - real PRIVMSGs landing in the channel
//	#   - if --mention is set: unread + mention badges light up on the
//	#     channel sidebar + server rail when the channel ISN'T active
//
// Flags let you point at a different server / nick / channel and configure
// the message + typing cadence.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/boson-chat/boson/engine/irc"
)

func main() {
	hostname := flag.String("host", "localhost", "IRC server hostname")
	port := flag.Int("port", 6667, "IRC server port")
	tls := flag.Bool("tls", false, "Use TLS")
	nick := flag.String("nick", "tester", "Bot nickname")
	channel := flag.String("channel", "#boson-typing-test", "Channel to join + type in")
	mention := flag.String("mention", "", "If set, every PRIVMSG begins with `<mention>: ` so the boson client treats it as a mention")
	msgInterval := flag.Duration("msg-interval", 8*time.Second, "How often to send a PRIVMSG into the channel")
	typingInterval := flag.Duration("typing-interval", 4*time.Second, "How often to refresh `+typing=active` (must be < 6s to avoid expiry)")
	flag.Parse()

	client, err := irc.New(irc.Config{
		Hostname: *hostname,
		Port:     *port,
		TLS:      *tls,
		Nick:     *nick,
	})
	if err != nil {
		log.Fatalf("typingbot: irc.New: %v", err)
	}

	// On JOIN echo for ourselves, kick off the typing loop.
	ready := make(chan struct{}, 1)
	client.OnEvent(func(e irc.Event) {
		switch e.Kind {
		case "001":
			log.Printf("typingbot: connected (RPL_WELCOME); joining %s", *channel)
			client.Join(*channel)
		case "JOIN":
			if e.From == *nick && e.Target == *channel {
				select {
				case ready <- struct{}{}:
				default:
				}
			}
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Println("typingbot: shutting down")
		client.Quit("bye")
		cancel()
	}()

	go func() {
		<-ready
		log.Printf("typingbot: in %s; +typing every %s, PRIVMSG every %s (mention=%q). Ctrl-C to stop.",
			*channel, *typingInterval, *msgInterval, *mention)
		typing := time.NewTicker(*typingInterval)
		msg := time.NewTicker(*msgInterval)
		defer typing.Stop()
		defer msg.Stop()
		// Fire one active immediately so the typing indicator lights up without a wait.
		client.Tagmsg(*channel, map[string]string{"+typing": "active"})

		messages := []string{
			"hello from the typingbot",
			"this is a test message",
			"ping! anyone there?",
			"checking the notification system",
			"another line for unread testing",
			"the rain in spain falls mainly on the plain",
		}
		idx := 0
		send := func() {
			body := messages[idx%len(messages)]
			idx++
			if *mention != "" {
				body = *mention + ": " + body
			}
			// PRIVMSG implicitly ends typing per IRCv3 spec — but we also
			// flip the tag manually so older clients see done explicitly.
			client.Tagmsg(*channel, map[string]string{"+typing": "done"})
			client.Privmsg(*channel, body)
		}

		for {
			select {
			case <-ctx.Done():
				return
			case <-typing.C:
				client.Tagmsg(*channel, map[string]string{"+typing": "active"})
			case <-msg.C:
				send()
			}
		}
	}()

	if err := client.Connect(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "typingbot: connect: %v\n", err)
		os.Exit(1)
	}
}
