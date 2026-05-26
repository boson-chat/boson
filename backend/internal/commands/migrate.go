package commands

import (
	"github.com/boson-chat/boson/backend/db"

	"github.com/spf13/cobra"
)

var migrateCmd = &cobra.Command{
	Use:   "migrate",
	Short: "Database migration commands",
}

var migrateUpCmd = &cobra.Command{
	Use:   "up",
	Short: "Run migrations up",
	RunE: func(cmd *cobra.Command, args []string) error {
		return db.MigrateUp()
	},
}

var migrateDownCmd = &cobra.Command{
	Use:   "down",
	Short: "Roll back migrations",
	RunE: func(cmd *cobra.Command, args []string) error {
		return db.MigrateDown()
	},
}

func init() {
	migrateCmd.AddCommand(migrateUpCmd)
	migrateCmd.AddCommand(migrateDownCmd)
	rootCmd.AddCommand(migrateCmd)
}
