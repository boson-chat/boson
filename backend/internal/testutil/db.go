// Package testutil provides shared test fixtures, primarily for tests that
// need a real Postgres connection. The boson Postgres on localhost:5432
// (from docker-compose) is used; an idempotent boson_test database is
// created on first use and reset between test runs.
package testutil

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/boson-chat/boson/backend/config"
	internaldb "github.com/boson-chat/boson/backend/internal/db"

	"github.com/golang-migrate/migrate/v4"
	migpostgres "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file" // register file:// source driver
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

const testDBName = "boson_test"

var (
	setupOnce sync.Once
	setupErr  error
)

// SetupDB ensures the boson_test database exists with the latest schema.
// Idempotent. Skips the test if Postgres is unreachable.
func SetupDB(t *testing.T) *internaldb.DB {
	t.Helper()
	setupOnce.Do(func() { setupErr = ensureSchema() })
	if setupErr != nil {
		if errors.Is(setupErr, errPGUnreachable) {
			t.Skip("Postgres not reachable on localhost:5432; skipping DB-backed test")
		}
		t.Fatal(setupErr)
	}

	gdb, err := gorm.Open(postgres.Open(testDSN()), &gorm.Config{})
	if err != nil {
		t.Fatalf("open test DB: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// Truncate all tables between tests so each test starts clean.
	require := func(s string) {
		if err := gdb.Exec(s).Error; err != nil {
			t.Fatalf("reset failed: %s: %v", s, err)
		}
	}
	require("TRUNCATE TABLE reports, handle_changes, user_server_links, servers, nick_claims, users CASCADE")

	return &internaldb.DB{DB: gdb}
}

var errPGUnreachable = errors.New("postgres unreachable")

func ensureSchema() error {
	// Create the test database if missing. Connect to "postgres" admin DB.
	adminDSN := dsn("postgres")
	adminDB, err := gorm.Open(postgres.Open(adminDSN), &gorm.Config{})
	if err != nil {
		return fmt.Errorf("%w: %v", errPGUnreachable, err)
	}
	defer func() {
		if sqlDB, err := adminDB.DB(); err == nil {
			_ = sqlDB.Close()
		}
	}()

	// CREATE DATABASE has no IF NOT EXISTS, and multiple test packages may
	// race to create it. Treat the well-known "already exists" error as success.
	if err := adminDB.Exec("CREATE DATABASE " + testDBName).Error; err != nil {
		msg := err.Error()
		if !strings.Contains(msg, "already exists") && !strings.Contains(msg, "duplicate key") {
			return err
		}
	}

	// Open the test DB and run migrations from db/migrations/.
	gdb, err := gorm.Open(postgres.Open(testDSN()), &gorm.Config{})
	if err != nil {
		return err
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		return err
	}
	defer sqlDB.Close()

	driver, err := migpostgres.WithInstance(sqlDB, &migpostgres.Config{})
	if err != nil {
		return err
	}

	migrationsPath := findMigrationsDir()
	m, err := migrate.NewWithDatabaseInstance("file://"+migrationsPath, testDBName, driver)
	if err != nil {
		return err
	}
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return err
	}
	return nil
}

func dsn(db string) string {
	cfg := dbConfig()
	cfg.Database = db
	return fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		cfg.Host, cfg.Port, cfg.User, cfg.Password, cfg.Database, cfg.SSLMode)
}

func testDSN() string { return dsn(testDBName) }

func dbConfig() config.DBConfig {
	host := getenv("TEST_DBHOST", "localhost")
	port := getenvUint("TEST_DBPORT", 5432)
	user := getenv("TEST_DBUSERNAME", "boson")
	password := getenv("TEST_DBPASSWORD", "boson")
	return config.DBConfig{
		Host:     host,
		Port:     port,
		User:     user,
		Password: password,
		Database: testDBName,
		SSLMode:  "disable",
	}
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
func getenvUint(key string, def uint) uint {
	if v := os.Getenv(key); v != "" {
		var n uint
		_, _ = fmt.Sscanf(v, "%d", &n)
		if n > 0 {
			return n
		}
	}
	return def
}

// findMigrationsDir walks up from the cwd to locate db/migrations.
// Tests in different packages have different cwds, so this avoids hardcoding.
func findMigrationsDir() string {
	dir, _ := os.Getwd()
	for i := 0; i < 6; i++ {
		candidate := dir + "/db/migrations"
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		dir = dir + "/.."
	}
	return "db/migrations"
}

// Ctx returns a background context; used as a stable test idiom.
func Ctx() context.Context { return context.Background() }
