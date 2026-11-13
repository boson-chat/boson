package authidentity_test

import (
	"context"
	"sync"
	"testing"

	"github.com/boson-chat/boson/backend/internal/services/authidentity"
	"github.com/boson-chat/boson/backend/internal/testutil"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDerivedUserIDIsStableV5(t *testing.T) {
	a := authidentity.DerivedUserID("usr_01HZY")
	assert.Equal(t, a, authidentity.DerivedUserID("usr_01HZY"))
	assert.NotEqual(t, a, authidentity.DerivedUserID("usr_01HZZ"))
	assert.Equal(t, uuid.Version(5), a.Version())
}

func TestResolveCreatesDerivedMappingOnce(t *testing.T) {
	db := testutil.SetupDB(t)
	svc := authidentity.NewService(db)
	ctx := context.Background()

	var wg sync.WaitGroup
	ids := make([]uuid.UUID, 8)
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id, err := svc.Resolve(ctx, "usr_01NEW")
			assert.NoError(t, err)
			ids[i] = id
		}(i)
	}
	wg.Wait()
	for _, id := range ids {
		assert.Equal(t, authidentity.DerivedUserID("usr_01NEW"), id)
	}
	var n int64
	require.NoError(t, db.DB.Table("auth_identities").Where("auth_user_id = ?", "usr_01NEW").Count(&n).Error)
	assert.EqualValues(t, 1, n)
}

func TestLinkedImportWinsOverDerived(t *testing.T) {
	db := testutil.SetupDB(t)
	svc := authidentity.NewService(db)
	ctx := context.Background()
	supabaseID := uuid.New()

	require.NoError(t, svc.Link(ctx, "usr_01OLD", supabaseID, authidentity.SourceSupabaseImport))
	require.NoError(t, svc.Link(ctx, "usr_01OLD", supabaseID, authidentity.SourceSupabaseImport), "idempotent")

	// A fresh service (no cache) resolves from the table.
	got, err := authidentity.NewService(db).Resolve(ctx, "usr_01OLD")
	require.NoError(t, err)
	assert.Equal(t, supabaseID, got)

	back, ok, err := svc.FindByUserID(ctx, supabaseID)
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, "usr_01OLD", back)
}

func TestLinkConflicts(t *testing.T) {
	db := testutil.SetupDB(t)
	svc := authidentity.NewService(db)
	ctx := context.Background()
	a, b := uuid.New(), uuid.New()
	require.NoError(t, svc.Link(ctx, "usr_01A", a, authidentity.SourceSupabaseImport))
	assert.ErrorIs(t, svc.Link(ctx, "usr_01A", b, authidentity.SourceSupabaseImport), authidentity.ErrConflict)
	assert.ErrorIs(t, svc.Link(ctx, "usr_01B", a, authidentity.SourceSupabaseImport), authidentity.ErrConflict)
	assert.ErrorIs(t, svc.Link(ctx, "not-a-sub", b, authidentity.SourceSupabaseImport), authidentity.ErrInvalidSubject)
	_, err := svc.Resolve(ctx, "")
	assert.ErrorIs(t, err, authidentity.ErrInvalidSubject)
}
