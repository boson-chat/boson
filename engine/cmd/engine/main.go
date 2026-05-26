// Command engine is the boson local Go process. It runs on the user's
// machine alongside Electron, owns IRC connections, and (later) handles
// crypto + identity sync with the boson backend.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/boson-chat/boson/engine/ipc"
	"github.com/boson-chat/boson/engine/irc"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "engine",
	Short: "Boson local Go process (IRC engine)",
}

// -------- `engine connect` (one-shot stdout streaming) --------

var (
	flagServer   string
	flagPort     int
	flagNoTLS    bool
	flagNick     string
	flagPassword string
	flagSASLUser string
	flagJoin     []string
)

var connectCmd = &cobra.Command{
	Use:   "connect",
	Short: "Connect to an IRC server and stream events as JSON on stdout",
	RunE: func(cmd *cobra.Command, _ []string) error {
		if flagServer == "" || flagNick == "" {
			return fmt.Errorf("--server and --nick are required")
		}

		cfg := irc.Config{
			Hostname: flagServer,
			Port:     flagPort,
			TLS:      !flagNoTLS,
			Nick:     flagNick,
		}
		if flagPassword != "" {
			user := flagSASLUser
			if user == "" {
				user = flagNick
			}
			cfg.SASL = &irc.SASLPlain{User: user, Password: flagPassword}
		}

		client, err := irc.New(cfg)
		if err != nil {
			return err
		}
		enc := json.NewEncoder(os.Stdout)
		client.OnEvent(func(e irc.Event) {
			_ = enc.Encode(e)
			if e.Kind == "001" {
				for _, ch := range flagJoin {
					client.Join(ch)
				}
			}
		})

		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		fmt.Fprintf(os.Stderr, "connecting: %s\n", client.String())
		return client.Connect(ctx)
	},
}

// -------- `engine serve` (WebSocket bridge for Electron) --------

var (
	flagServeAddr      string
	flagDiscoveryPath  string
	flagTokenFromEnv   bool
)

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the WebSocket bridge for the Electron renderer",
	RunE: func(cmd *cobra.Command, _ []string) error {
		token := os.Getenv("BOSON_ENGINE_TOKEN")
		if !flagTokenFromEnv || token == "" {
			t, err := ipc.GenerateToken()
			if err != nil {
				return fmt.Errorf("generate token: %w", err)
			}
			token = t
		}

		wsURL, err := ipc.BuildWSURL(flagServeAddr)
		if err != nil {
			return err
		}
		if err := ipc.WriteDiscovery(flagDiscoveryPath, wsURL, token); err != nil {
			return fmt.Errorf("write discovery: %w", err)
		}
		discoveryPath := flagDiscoveryPath
		if discoveryPath == "" {
			discoveryPath = ipc.DefaultDiscoveryPath()
		}

		fmt.Fprintf(os.Stderr, "engine serving on %s\n", wsURL)
		fmt.Fprintf(os.Stderr, "discovery file: %s\n", discoveryPath)

		server := ipc.NewServer(flagServeAddr, token)
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		return server.ListenAndServe(ctx)
	},
}

func init() {
	connectCmd.Flags().StringVar(&flagServer, "server", "", "IRC hostname")
	connectCmd.Flags().IntVar(&flagPort, "port", 6697, "IRC port")
	connectCmd.Flags().BoolVar(&flagNoTLS, "no-tls", false, "disable TLS")
	connectCmd.Flags().StringVar(&flagNick, "nick", "", "IRC nickname")
	connectCmd.Flags().StringVar(&flagPassword, "password", "", "SASL PLAIN password")
	connectCmd.Flags().StringVar(&flagSASLUser, "sasl-user", "", "SASL account (defaults to --nick)")
	connectCmd.Flags().StringSliceVar(&flagJoin, "join", nil, "channels to join after welcome (repeatable)")
	rootCmd.AddCommand(connectCmd)

	serveCmd.Flags().StringVar(&flagServeAddr, "addr", "127.0.0.1:7331", "address to bind the WebSocket bridge")
	serveCmd.Flags().StringVar(&flagDiscoveryPath, "discovery", "", "path to write engine.json (defaults to $XDG_RUNTIME_DIR/boson/engine.json)")
	serveCmd.Flags().BoolVar(&flagTokenFromEnv, "token-from-env", false, "use BOSON_ENGINE_TOKEN instead of generating a random token")
	rootCmd.AddCommand(serveCmd)
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
