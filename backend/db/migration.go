package db

import (
	"embed"
	"fmt"
	"net/http"

	"github.com/boson-chat/boson/backend/config"
	internaldb "github.com/boson-chat/boson/backend/internal/db"

	"github.com/golang-migrate/migrate/v4"
	migpostgres "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source"
	"github.com/golang-migrate/migrate/v4/source/httpfs"
)

//go:embed migrations/*.sql
var migrations embed.FS

type embedDriver struct {
	httpfs.PartialDriver
}

func (d *embedDriver) Open(rawURL string) (source.Driver, error) {
	if err := d.PartialDriver.Init(http.FS(migrations), "migrations"); err != nil {
		return nil, err
	}
	return d, nil
}

func getMigration() (*migrate.Migrate, error) {
	cfg := config.LoadConfigOrPanic()
	database := internaldb.NewDatabase(cfg.DBConfig)
	sqldb, err := database.DB.DB()
	if err != nil {
		return nil, err
	}

	driver, err := migpostgres.WithInstance(sqldb, &migpostgres.Config{})
	if err != nil {
		return nil, err
	}

	source.Register("embed", &embedDriver{})
	return migrate.NewWithDatabaseInstance("embed://", cfg.DBConfig.Database, driver)
}

func MigrateUp() error {
	m, err := getMigration()
	if err != nil {
		return fmt.Errorf("init migrate: %w", err)
	}
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return err
	}
	return nil
}

func MigrateDown() error {
	m, err := getMigration()
	if err != nil {
		return fmt.Errorf("init migrate: %w", err)
	}
	return m.Down()
}
