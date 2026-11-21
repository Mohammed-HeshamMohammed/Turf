package crm

// Build step 38 (migrations/0044_file_sharing.sql): sharing a lead's files outside the agency. Team leads, admins and the owner share
// a file with the lead's clients or by a link that expires; every share is recorded and can be withdrawn; every opening of a shared
// file is recorded with who or which network and when (D256, D258).

import (
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	linkDaysDefault = 7
	linkDaysMax     = 30
)

func (s *server) fileRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/leads/{id}/files", s.member(s.listFiles))
	mux.Handle("POST /api/v1/leads/{id}/files", s.member(s.uploadFile))
	mux.Handle("GET /api/v1/files/storage", s.member(s.fileStorage))
	mux.Handle("GET /api/v1/files/{id}", s.member(s.downloadFile))
	mux.Handle("DELETE /api/v1/files/{id}", s.member(s.deleteFile))
	mux.Handle("PATCH /api/v1/files/{id}", s.member(s.shareWithClients))
	mux.Handle("POST /api/v1/files/{id}/links", s.member(s.makeFileLink))
	mux.Handle("DELETE /api/v1/files/{id}/shares/{share}", s.member(s.withdrawShare))
	mux.Handle("GET /api/v1/files/{id}/activity", s.member(s.fileActivity))
	mux.HandleFunc("GET /api/v1/public/files/{token}", s.openFileLink)
}

// sharer opens the file for someone who may share it, in the asker's transaction.
func (s *server) sharer(q *req, tx pgx.Tx) (*leadFile, error) {
	id := q.r.PathValue("id")
	if !validID(id) {
		return nil, notFound("That file does not exist.")
	}
	f, err := fileFor(tx, q, id)
	if err != nil {
		return nil, err
	}
	ok, err := sharesFiles(q.r.Context(), tx, q.sc, f.lead)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, forbidden("Team leads, admins and the owner share files outside the agency.")
	}
	return f, nil
}

// shareWithClients answers PATCH /api/v1/files/{id} {visibility: shared|internal}: shown to the lead's clients, or no longer.
func (s *server) shareWithClients(q *req) error {
	var body struct {
		Visibility string `json:"visibility"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	if body.Visibility != "shared" && body.Visibility != "internal" {
		return bad("visibility is shared (the lead's clients see it) or internal.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	f, err := s.sharer(q, tx)
	if err != nil {
		return err
	}
	id := q.r.PathValue("id")
	if body.Visibility == "shared" && f.visibility != "shared" {
		if f.scan == "infected" {
			return openable(f.scan)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO file_shares (org_id, file_id, kind, created_by, created_label) VALUES (cw_org(), $1, 'clients', $2, $3)`, id, q.sc.userID, q.sc.label); err != nil {
			return err
		}
	}
	if body.Visibility == "internal" {
		if _, err := tx.Exec(ctx, `UPDATE file_shares SET withdrawn_at = now(), withdrawn_by = $2 WHERE file_id = $1 AND kind = 'clients' AND withdrawn_at IS NULL`, id, q.sc.userID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE lead_files SET visibility = $2 WHERE id = $1`, id, body.Visibility); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"id": id, "visibility": body.Visibility})
	return nil
}

// makeFileLink answers POST /api/v1/files/{id}/links {for, days}: an address for someone outside, which stops after the days given
// (7 unless said, at most 30) or when withdrawn.
func (s *server) makeFileLink(q *req) error {
	var body struct {
		For  string `json:"for"`
		Days int    `json:"days"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	body.For = strings.TrimSpace(body.For)
	if body.For == "" || len(body.For) > 200 {
		return bad("Say who the link is for (up to 200 characters), so its openings can be told apart.")
	}
	if body.Days == 0 {
		body.Days = linkDaysDefault
	}
	if body.Days < 1 || body.Days > linkDaysMax {
		return bad("A link lasts 1 to 30 days.")
	}
	if s.cfg.emailPublicURL == "" {
		return &apiError{http.StatusServiceUnavailable, "links_off", "Links to files are not set up for Caller Whale yet."}
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	f, err := s.sharer(q, tx)
	if err != nil {
		return err
	}
	if f.scan == "infected" {
		return openable(f.scan)
	}
	token := orgToken(q.sc.orgID)
	expires := s.now().Add(time.Duration(body.Days) * 24 * time.Hour)
	var share string
	if err := tx.QueryRow(ctx, `INSERT INTO file_shares (org_id, file_id, kind, token, recipient, expires_at, created_by, created_label)
		VALUES (cw_org(), $1, 'link', $2, $3, $4, $5, $6) RETURNING id::text`, q.r.PathValue("id"), token, body.For, expires, q.sc.userID, q.sc.label).Scan(&share); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"id": share, "url": s.cfg.emailPublicURL + "/api/v1/public/files/" + token, "expires_at": expires})
	return nil
}

// withdrawShare answers DELETE /api/v1/files/{id}/shares/{share}: the link stops working, or the clients no longer see the file.
func (s *server) withdrawShare(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := s.sharer(q, tx); err != nil {
		return err
	}
	var kind string
	err = tx.QueryRow(ctx, `UPDATE file_shares SET withdrawn_at = now(), withdrawn_by = $3 WHERE id = $1 AND file_id = $2 AND withdrawn_at IS NULL RETURNING kind`,
		nullID(q.r.PathValue("share")), q.r.PathValue("id"), q.sc.userID).Scan(&kind)
	if err == pgx.ErrNoRows {
		return notFound("That share does not exist or was already withdrawn.")
	}
	if err != nil {
		return err
	}
	if kind == "clients" {
		if _, err := tx.Exec(ctx, `UPDATE lead_files SET visibility = 'internal' WHERE id = $1`, q.r.PathValue("id")); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// fileActivity answers GET /api/v1/files/{id}/activity: every share and every opening of the file.
func (s *server) fileActivity(q *req) error {
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := s.sharer(q, tx); err != nil {
		return err
	}
	id := q.r.PathValue("id")
	shares, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('id', id, 'kind', kind, 'for', recipient, 'expires_at', expires_at, 'shared_by', created_label,
			'shared_at', created_at, 'withdrawn_at', withdrawn_at, 'active', withdrawn_at IS NULL AND (expires_at IS NULL OR expires_at > now()))
		FROM file_shares WHERE file_id = $1 ORDER BY created_at DESC`, id)
	if err != nil {
		return err
	}
	opens, err := queryJSON(ctx, tx, `SELECT jsonb_build_object('share_id', o.share_id, 'who', CASE WHEN o.user_id IS NOT NULL THEN o.label ELSE coalesce(sh.recipient, '') END,
			'network', o.network, 'at', o.at)
		FROM file_opens o LEFT JOIN file_shares sh ON sh.id = o.share_id WHERE o.file_id = $1 ORDER BY o.at DESC LIMIT 500`, id)
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"shares": shares, "opens": opens})
	return nil
}

// openFileLink answers GET /api/v1/public/files/{token}: the file, while its link stands and once it is scanned; each opening is kept.
func (s *server) openFileLink(w http.ResponseWriter, r *http.Request) {
	var f leadFile
	gone, waiting := false, false
	err := s.inOrg(r.Context(), r.PathValue("token"), func(tx pgx.Tx) error {
		var share string
		var live bool
		err := tx.QueryRow(r.Context(), `SELECT sh.id::text, f.id::text, f.name, f.mime, f.scan, f.body, sh.withdrawn_at IS NULL AND sh.expires_at > now()
			FROM file_shares sh JOIN lead_files f ON f.id = sh.file_id WHERE sh.token = $1 AND sh.kind = 'link'`, r.PathValue("token")).
			Scan(&share, &f.lead, &f.name, &f.kind, &f.scan, &f.body, &live)
		if err != nil {
			return err
		}
		if !live || f.scan == "infected" {
			gone = true
			return nil
		}
		if f.scan != "clean" {
			waiting = true
			return nil
		}
		ip := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0])
		_, err = tx.Exec(r.Context(), `INSERT INTO file_opens (org_id, file_id, share_id, network) VALUES (cw_org(), $1, $2, $3)`, f.lead, share, ip)
		return err
	})
	switch {
	case err == pgx.ErrNoRows:
		http.Error(w, "This link does not exist.", http.StatusNotFound)
	case err != nil:
		http.Error(w, "Something went wrong. Try again in a moment.", http.StatusInternalServerError)
	case waiting:
		http.Error(w, "This file is still being checked. Try again in a minute.", http.StatusConflict)
	case gone:
		http.Error(w, "This link has expired or was withdrawn. Ask whoever sent it for a new one.", http.StatusGone)
	default:
		w.Header().Set("Referrer-Policy", "no-referrer")
		serveFile(w, &f)
	}
}
