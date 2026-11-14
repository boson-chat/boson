package db

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/boson-chat/boson/backend/internal/testutil"

	"github.com/golang-migrate/migrate/v4"
	migpostgres "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// Own database so the round trip never disturbs boson_test, which the
// repository tests share.
const migrateTestDB = "boson_migrate_test"

// directoryTables were dropped in 000011; its down migration must put them
// back exactly as 000001 + 000003 + 000008 left them.
var directoryTables = []string{"servers", "user_server_links", "reports"}

func openSQL(dsn string) (*sql.DB, error) {
	g, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		return nil, err
	}
	return g.DB()
}

func openMigrateTestDB(t *testing.T) *sql.DB {
	t.Helper()
	admin, err := openSQL(testutil.DSN("postgres"))
	if err != nil {
		t.Skipf("Postgres not reachable: %v", err)
	}
	defer admin.Close()
	if _, err := admin.Exec("DROP DATABASE IF EXISTS " + migrateTestDB + " WITH (FORCE)"); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec("CREATE DATABASE " + migrateTestDB); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if a, err := openSQL(testutil.DSN("postgres")); err == nil {
			_, _ = a.Exec("DROP DATABASE IF EXISTS " + migrateTestDB + " WITH (FORCE)")
			_ = a.Close()
		}
	})
	db, err := openSQL(testutil.DSN(migrateTestDB))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func newTestMigrate(t *testing.T, db *sql.DB) *migrate.Migrate {
	t.Helper()
	src, err := iofs.New(migrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	driver, err := migpostgres.WithInstance(db, &migpostgres.Config{})
	if err != nil {
		t.Fatal(err)
	}
	m, err := migrate.NewWithInstance("iofs", src, migrateTestDB, driver)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// schemaOf describes the given tables: columns (type, nullability, default,
// generation expression), constraints and indexes, in a stable order.
func schemaOf(t *testing.T, db *sql.DB, tables []string) string {
	t.Helper()
	var b strings.Builder
	q := func(query string, args ...any) {
		rows, err := db.Query(query, args...)
		if err != nil {
			t.Fatalf("%s: %v", query, err)
		}
		defer rows.Close()
		cols, _ := rows.Columns()
		vals := make([]sql.NullString, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		for rows.Next() {
			if err := rows.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			for _, v := range vals {
				fmt.Fprintf(&b, "%s|", v.String)
			}
			b.WriteString("\n")
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
	}
	for _, tbl := range tables {
		fmt.Fprintf(&b, "== %s\n", tbl)
		q(`SELECT column_name, data_type, udt_name, is_nullable, column_default,
		          is_generated, generation_expression
		     FROM information_schema.columns
		    WHERE table_schema = 'public' AND table_name = $1
		    ORDER BY ordinal_position`, tbl)
		q(`SELECT conname, pg_get_constraintdef(oid)
		     FROM pg_constraint
		    WHERE conrelid = ('public.' || $1)::regclass
		    ORDER BY conname`, tbl)
		q(`SELECT indexname, indexdef FROM pg_indexes
		    WHERE schemaname = 'public' AND tablename = $1
		    ORDER BY indexname`, tbl)
	}
	return b.String()
}

func tableExists(t *testing.T, db *sql.DB, tbl string) bool {
	t.Helper()
	var reg sql.NullString
	if err := db.QueryRow(`SELECT to_regclass('public.' || $1)::text`, tbl).Scan(&reg); err != nil {
		t.Fatal(err)
	}
	return reg.Valid
}

func TestMigrationsRoundTrip(t *testing.T) {
	db := openMigrateTestDB(t)
	m := newTestMigrate(t, db)

	// Schema of the directory tables as 000001..000010 left them.
	if err := m.Migrate(10); err != nil {
		t.Fatalf("migrate to 10: %v", err)
	}
	before := schemaOf(t, db, directoryTables)
	for _, want := range []string{
		"search_vector|tsvector|tsvector|YES||ALWAYS|",
		"verification_token_issued_at|",
		"icon_storage_key|", "banner_storage_key|",
		"servers_verification_token_issued_at_idx|",
		"WHERE (verification_status = 'pending'::text)",
		"FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE",
	} {
		if !strings.Contains(before, want) {
			t.Fatalf("v10 schema missing %q:\n%s", want, before)
		}
	}

	// 000011 drops them.
	if err := m.Up(); err != nil {
		t.Fatalf("up: %v", err)
	}
	if v, dirty, _ := m.Version(); v != 11 || dirty {
		t.Fatalf("version = %d dirty=%v, want 11", v, dirty)
	}
	for _, tbl := range directoryTables {
		if tableExists(t, db, tbl) {
			t.Fatalf("%s still exists after 000011 up", tbl)
		}
	}

	// 000011 down recreates them identically.
	if err := m.Migrate(10); err != nil {
		t.Fatalf("down to 10: %v", err)
	}
	if after := schemaOf(t, db, directoryTables); after != before {
		t.Fatalf("000011 down schema differs from v10:\n--- v10\n%s\n--- after down\n%s", before, after)
	}

	// Every migration goes all the way down and back up cleanly.
	if err := m.Down(); err != nil {
		t.Fatalf("down: %v", err)
	}
	if err := m.Up(); err != nil {
		t.Fatalf("up again: %v", err)
	}
	if srcErr, dbErr := m.Close(); srcErr != nil || dbErr != nil {
		t.Fatal(errors.Join(srcErr, dbErr))
	}
}
