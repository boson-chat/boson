package commands

import (
	"context"

	"github.com/boson-chat/boson/backend/config"
	"github.com/boson-chat/boson/backend/http"
	"github.com/boson-chat/boson/backend/internal/logger"

	"github.com/spf13/cobra"
)

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the HTTP server",
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg := config.LoadConfigOrPanic()

		logger.Logger(
			logger.WithServerName("boson"),
			logger.WithVersion("0.0.1"),
			logger.WithEnvironment(cfg.AppConfig.Env),
		)

		return http.StartServerWithContext(context.Background())
	},
}

func init() {
	rootCmd.AddCommand(serveCmd)
}
