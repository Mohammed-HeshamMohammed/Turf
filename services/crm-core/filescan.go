package main

// Build step 38: every file on a lead is scanned before anyone can open it (D257), by ClamAV's clamd over its INSTREAM command.

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// fileScanner says whether a file is safe: clean, or the name of what was found.
type fileScanner interface {
	scan(ctx context.Context, body []byte) (clean bool, found string, err error)
}

// clamd talks to ClamAV's daemon (CLAMD_ADDR, like clamav:3310). Its StreamMaxLength must be above 25 MB.
type clamd struct{ addr string }

func (c clamd) scan(ctx context.Context, body []byte) (bool, string, error) {
	d := net.Dialer{Timeout: 5 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", c.addr)
	if err != nil {
		return false, "", err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
	w := bufio.NewWriter(conn)
	if _, err := w.WriteString("zINSTREAM\x00"); err != nil {
		return false, "", err
	}
	size := make([]byte, 4)
	for start := 0; start < len(body); start += 1 << 16 {
		chunk := body[start:min(start+1<<16, len(body))]
		binary.BigEndian.PutUint32(size, uint32(len(chunk)))
		_, _ = w.Write(size)
		if _, err := w.Write(chunk); err != nil {
			return false, "", err
		}
	}
	binary.BigEndian.PutUint32(size, 0)
	_, _ = w.Write(size)
	if err := w.Flush(); err != nil {
		return false, "", err
	}
	reply, err := bufio.NewReader(conn).ReadString(0)
	if err != nil && reply == "" {
		return false, "", err
	}
	reply = strings.TrimSpace(strings.TrimRight(reply, "\x00"))
	switch {
	case strings.HasSuffix(reply, " OK"):
		return true, "", nil
	case strings.HasSuffix(reply, " FOUND"):
		return false, strings.TrimSuffix(strings.TrimPrefix(reply, "stream: "), " FOUND"), nil
	default:
		return false, "", fmt.Errorf("clamd: %s", reply)
	}
}

// scanFile scans one waiting file in its agency and records the answer; a scanner that cannot be reached leaves it waiting.
func (s *server) scanFile(ctx context.Context, org, id string) error {
	if s.scanner == nil {
		return nil
	}
	tx, err := s.st.begin(ctx, scope{orgID: org})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var body []byte
	err = tx.QueryRow(ctx, `SELECT body FROM lead_files WHERE id = $1 AND scan = 'waiting'`, id).Scan(&body)
	if err == pgx.ErrNoRows {
		_, err = s.st.db.Exec(ctx, `DELETE FROM file_scans WHERE file_id = $1`, id)
		return err
	}
	if err != nil {
		return err
	}
	clean, found, err := s.scanner.scan(ctx, body)
	if err != nil {
		_, _ = s.st.db.Exec(ctx, `UPDATE file_scans SET tries = tries + 1, due_at = now() + least(make_interval(mins => tries + 1), interval '1 hour') WHERE file_id = $1`, id)
		return err
	}
	if clean {
		_, err = tx.Exec(ctx, `UPDATE lead_files SET scan = 'clean', scanned_at = now() WHERE id = $1`, id)
	} else {
		// A harmful file is never served; its content is dropped and the row says what was found.
		_, err = tx.Exec(ctx, `UPDATE lead_files SET scan = 'infected', scanned_at = now(), scan_note = $2, body = '\x' WHERE id = $1`, id, found)
		_, _ = tx.Exec(ctx, `UPDATE file_shares SET withdrawn_at = now() WHERE file_id = $1 AND withdrawn_at IS NULL`, id)
	}
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	_, err = s.st.db.Exec(ctx, `DELETE FROM file_scans WHERE file_id = $1`, id)
	return err
}

// queueScan puts a waiting file in line for the scanner.
func queueScan(ctx context.Context, tx pgx.Tx, id string) error {
	_, err := tx.Exec(ctx, `INSERT INTO file_scans (file_id, org_id) VALUES ($1, cw_org()) ON CONFLICT (file_id) DO NOTHING`, id)
	return err
}

// scanWaiting scans the files whose turn has come.
func (s *server) scanWaiting(ctx context.Context) error {
	rows, err := s.st.db.Query(ctx, `SELECT file_id::text, org_id::text FROM file_scans WHERE due_at <= now() ORDER BY due_at LIMIT 50`)
	if err != nil {
		return err
	}
	type due struct{ id, org string }
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (due, error) {
		var d due
		return d, r.Scan(&d.id, &d.org)
	})
	if err != nil {
		return err
	}
	for _, d := range list {
		if err := s.scanFile(ctx, d.org, d.id); err != nil {
			log.Printf("WARN scanning file %s: %v", d.id, err)
		}
	}
	return nil
}

func (s *server) scanWaitingPeriodically(ctx context.Context) {
	if s.scanner == nil {
		log.Printf("WARN CLAMD_ADDR is not set: files on leads wait unopened until a scanner is set up")
		return
	}
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.scanWaiting(ctx); err != nil {
				log.Printf("WARN files waiting for the scanner: %v", err)
			}
		}
	}
}
