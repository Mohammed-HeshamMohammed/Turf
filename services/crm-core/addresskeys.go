package crm

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// fillAddressKeys works out the stored address key (0050) of properties that do not have one yet, 5,000 at a time, one agency at a
// time (row security lets an update reach only the agency it is set to), for up to a minute. It reports how many it filled.
func (s *server) fillAddressKeys(ctx context.Context) (int64, error) {
	started, filled := time.Now(), int64(0)
	for time.Since(started) < time.Minute {
		var org string
		err := func() error {
			tx, err := s.st.db.Begin(ctx)
			if err != nil {
				return err
			}
			defer tx.Rollback(ctx)
			if _, err = tx.Exec(ctx, `SELECT set_config('cw.matching', 'on', true)`); err != nil { // read across agencies (0002)
				return err
			}
			return tx.QueryRow(ctx, `SELECT org_id::text FROM properties WHERE addr_key IS NULL LIMIT 1`).Scan(&org)
		}()
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return filled, nil
			}
			return filled, err
		}
		tx, err := s.st.begin(ctx, scope{orgID: org})
		if err != nil {
			return filled, err
		}
		tag, err := tx.Exec(ctx, `UPDATE properties SET addr_key = coalesce(importing.addr_key(address, postal_code), '')
			WHERE id IN (SELECT id FROM properties WHERE org_id = cw_org() AND addr_key IS NULL LIMIT 5000 FOR UPDATE SKIP LOCKED)`)
		if err == nil {
			err = tx.Commit(ctx)
		}
		tx.Rollback(ctx)
		if err != nil {
			return filled, err
		}
		filled += tag.RowsAffected()
	}
	return filled, nil
}
