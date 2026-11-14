package commands

import (
	"github.com/boson-chat/boson/backend/config"

	"github.com/spf13/cobra"
)

var exportConfigCmd = &cobra.Command{
	Use:   "export-config",
	Short: "Print the nick_claim: section of the stack config file from the env and BOSON_CONFIG",
	Long: `Prints YAML for config/boson.yaml built from the env values
(NICK_CLAIM_* and the older PURELYMAIL_POP3_*). enabled is true when
NICK_CLAIM_ENABLED=true or a POP3 host is set, so an install that ran the
nick-claim worker keeps it on after the move to the file. When BOSON_CONFIG
points at an existing file its nick_claim: section is applied on top. No
database is needed, and the password is never printed.`,
	RunE: func(cmd *cobra.Command, _ []string) error {
		cfg := config.LoadConfigOrPanic()
		out, err := config.ExportNickClaimWithFile(cfg.AppConfig, cfg.StackConfig.Path)
		if err != nil {
			return err
		}
		_, err = cmd.OutOrStdout().Write(out)
		return err
	},
}

func init() {
	rootCmd.AddCommand(exportConfigCmd)
}
