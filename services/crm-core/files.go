package crm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Files on a lead: the Documents tab. Anyone who sees the lead sees its files (a client only the shared ones); whoever can edit the
// lead uploads them; the uploader or an editor removes them. Build step 38 (D256-D258): up to 25 MB, PDF, Word, Excel or common
// images whose content matches, each scanned before anyone can open it, and stored against the plan; sharing is for team leads,
// admins and the owner (files_share.go).

const maxFile = 25 << 20

var fileTypes = []string{
	"application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif", "image/heic",
	"application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

// looksLike is whether a file's first bytes match the type it claims, so a program can't come in named as a document.
func looksLike(kind string, b []byte) bool {
	switch kind {
	case "application/pdf":
		return bytes.HasPrefix(b, []byte("%PDF-"))
	case "image/png":
		return bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n"))
	case "image/jpeg":
		return bytes.HasPrefix(b, []byte("\xff\xd8\xff"))
	case "image/gif":
		return bytes.HasPrefix(b, []byte("GIF87a")) || bytes.HasPrefix(b, []byte("GIF89a"))
	case "image/webp":
		return len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP"
	case "image/heic":
		return len(b) >= 12 && string(b[4:8]) == "ftyp"
	case "application/msword", "application/vnd.ms-excel":
		return bytes.HasPrefix(b, []byte("\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"))
	default: // the Office formats since 2007 are zip files
		return bytes.HasPrefix(b, []byte("PK\x03\x04"))
	}
}

const fileColumns = `jsonb_build_object('id', f.id, 'lead_id', f.lead_id, 'name', f.name, 'mime', f.mime, 'size', f.size, 'visibility', f.visibility,
	'uploaded_by', f.uploaded_by, 'uploaded_label', f.uploaded_label, 'created_at', f.created_at, 'scan', f.scan, 'scan_note', f.scan_note)`

// editableLead says whether the asker sees the lead, and whether they may change it.
func editableLead(tx pgx.Tx, q *req, id string) (seen, editable bool, err error) {
	var assignee *string
	err = tx.QueryRow(q.r.Context(), `SELECT l.assignee_id::text FROM leads l WHERE l.id = $1 AND l.deleted_at IS NULL AND cw_visible_lead(l.id)`, id).Scan(&assignee)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	lead := map[string]any{"assignee_id": nil}
	if assignee != nil {
		lead["assignee_id"] = *assignee
	}
	return true, !q.sc.external() && q.sc.can("edit") && canEditLead(q.sc, lead), nil
}

// sharesFiles is whether the asker shares a lead's files outside the agency: the owner or an admin, or a lead of the lead's team (D256).
func sharesFiles(ctx context.Context, tx pgx.Tx, sc scope, lead string) (bool, error) {
	if sc.external() {
		return false, nil
	}
	if manages(sc) {
		return true, nil
	}
	var team *string
	if err := tx.QueryRow(ctx, `SELECT team_id::text FROM leads WHERE id = $1`, lead).Scan(&team); err != nil {
		return false, err
	}
	return team != nil && slices.Contains(sc.managed, *team), nil
}

// listFiles answers GET /api/v1/leads/{id}/files.
func (s *server) listFiles(q *req) error {
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("That lead does not exist.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	seen, editable, err := editableLead(tx, q, id)
	if err != nil {
		return err
	}
	if !seen {
		return notFound("That lead does not exist.")
	}
	files, err := queryJSON(ctx, tx, `SELECT `+fileColumns+` FROM lead_files f WHERE f.lead_id = $1 AND (NOT cw_external() OR (f.visibility = 'shared' AND f.scan = 'clean')) ORDER BY f.created_at DESC`, id)
	if err != nil {
		return err
	}
	shares, err := sharesFiles(ctx, tx, q.sc, id)
	if err != nil {
		return err
	}
	// Files from before scanning, or that the scanner missed, are put in line again.
	if !q.sc.external() {
		if _, err := tx.Exec(ctx, `INSERT INTO file_scans (file_id, org_id) SELECT id, org_id FROM lead_files WHERE lead_id = $1 AND scan = 'waiting' ON CONFLICT (file_id) DO NOTHING`, id); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"files": files, "can_upload": editable, "can_share": shares})
	return nil
}

// uploadFile answers POST /api/v1/leads/{id}/files?name=…&visibility=internal|shared, the file itself as the body.
func (s *server) uploadFile(q *req) error {
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("That lead does not exist.")
	}
	name := strings.TrimSpace(q.r.URL.Query().Get("name"))
	name = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`/\<>:"|?*`, r) {
			return '_'
		}
		return r
	}, name)
	if name == "" || len([]rune(name)) > 200 {
		return bad("Give the file a name (up to 200 characters).")
	}
	visibility := q.r.URL.Query().Get("visibility")
	if visibility == "" {
		visibility = "internal"
	}
	if visibility != "internal" && visibility != "shared" {
		return bad("A file is internal or shared.")
	}
	kind, _, _ := mime.ParseMediaType(q.r.Header.Get("Content-Type"))
	if !slices.Contains(fileTypes, kind) {
		return bad("Upload a PDF, a Word or Excel document, or a photo (PNG, JPEG, WebP, GIF or HEIC).")
	}
	body, err := io.ReadAll(http.MaxBytesReader(q.w, q.r.Body, maxFile+1))
	if err != nil || len(body) > maxFile {
		return bad("A file can be up to 25 MB.")
	}
	if len(body) == 0 {
		return bad("That file is empty.")
	}
	if !looksLike(kind, body) {
		return bad("That file is not the kind it says it is.")
	}
	ctx := q.r.Context()
	if err := s.roomFor(ctx, q.sc, int64(len(body))); err != nil {
		return err
	}
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	seen, editable, err := editableLead(tx, q, id)
	if err != nil {
		return err
	}
	if !seen {
		return notFound("That lead does not exist.")
	}
	if !editable {
		return forbidden("Only someone who can edit this lead adds files to it.")
	}
	if visibility == "shared" {
		if ok, err := sharesFiles(ctx, tx, q.sc, id); err != nil {
			return err
		} else if !ok {
			return forbidden("Team leads, admins and the owner share files with clients. Add it as internal.")
		}
	}
	var fileID string
	if err := tx.QueryRow(ctx, `INSERT INTO lead_files (org_id, lead_id, name, mime, size, visibility, uploaded_by, uploaded_label, body)
		VALUES (cw_org(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text`, id, name, kind, len(body), visibility, q.sc.userID, q.sc.label, body).Scan(&fileID); err != nil {
		return err
	}
	if visibility == "shared" {
		if _, err := tx.Exec(ctx, `INSERT INTO file_shares (org_id, file_id, kind, created_by, created_label) VALUES (cw_org(), $1, 'clients', $2, $3)`, fileID, q.sc.userID, q.sc.label); err != nil {
			return err
		}
	}
	if err := queueScan(ctx, tx, fileID); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	// Scanned now when the scanner answers; otherwise the loop tries again and the file waits.
	if err := s.scanFile(ctx, q.sc.orgID, fileID); err != nil {
		log.Printf("WARN scanning file %s: %v", fileID, err)
	}
	tx2, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx2.Rollback(ctx)
	file, err := queryJSON(ctx, tx2, `SELECT `+fileColumns+` FROM lead_files f WHERE f.id = $1`, fileID)
	if err != nil {
		return err
	}
	q.w.Header().Set("Content-Type", "application/json")
	q.w.WriteHeader(http.StatusCreated)
	_, _ = q.w.Write(file[0])
	return nil
}

type leadFile struct {
	lead, name, kind, visibility, scan string
	removable                          bool
	body                               []byte
}

// fileFor finds a file the asker may see, and whether they may remove it.
func fileFor(tx pgx.Tx, q *req, id string) (*leadFile, error) {
	var f leadFile
	var uploader string
	err := tx.QueryRow(q.r.Context(), `SELECT f.lead_id::text, f.name, f.mime, f.uploaded_by::text, f.visibility, f.scan, f.body FROM lead_files f WHERE f.id = $1`, id).
		Scan(&f.lead, &f.name, &f.kind, &uploader, &f.visibility, &f.scan, &f.body)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("That file does not exist.")
	}
	if err != nil {
		return nil, err
	}
	seen, editable, err := editableLead(tx, q, f.lead)
	if err != nil {
		return nil, err
	}
	if !seen || (q.sc.external() && (f.visibility != "shared" || f.scan != "clean")) {
		return nil, notFound("That file does not exist.")
	}
	f.removable = editable || (uploader == q.sc.userID && !q.sc.external())
	return &f, nil
}

// openable refuses a file the scanner has not passed.
func openable(scan string) error {
	switch scan {
	case "clean":
		return nil
	case "infected":
		return &apiError{http.StatusGone, "harmful_file", "The scan found something harmful in this file, so it can't be opened. Ask for a clean copy."}
	default:
		return &apiError{http.StatusConflict, "scanning", "This file is still being checked. Try again in a minute."}
	}
}

func serveFile(w http.ResponseWriter, f *leadFile) {
	w.Header().Set("Content-Type", f.kind)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": f.name}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	_, _ = w.Write(f.body)
}

// downloadFile answers GET /api/v1/files/{id}: the file itself, once scanned. A client's download is recorded (D258).
func (s *server) downloadFile(q *req) error {
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("That file does not exist.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	f, err := fileFor(tx, q, id)
	if err != nil {
		return err
	}
	if f.scan == "waiting" {
		_ = queueScan(ctx, tx, id)
		_ = tx.Commit(ctx)
	}
	if err := openable(f.scan); err != nil {
		return err
	}
	if q.sc.external() {
		if _, err := tx.Exec(ctx, `INSERT INTO file_opens (org_id, file_id, share_id, user_id, label)
			VALUES (cw_org(), $1, (SELECT id FROM file_shares WHERE file_id = $1 AND kind = 'clients' AND withdrawn_at IS NULL ORDER BY created_at DESC LIMIT 1), $2, $3)`,
			id, q.sc.userID, q.sc.label); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	serveFile(q.w, f)
	return nil
}

// deleteFile answers DELETE /api/v1/files/{id}.
func (s *server) deleteFile(q *req) error {
	id := q.r.PathValue("id")
	if !validID(id) {
		return notFound("That file does not exist.")
	}
	ctx := q.r.Context()
	tx, err := s.st.begin(ctx, q.sc)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	f, err := fileFor(tx, q, id)
	if err != nil {
		return err
	}
	if !f.removable {
		return forbidden("Only whoever added the file, or someone who can edit the lead, removes it.")
	}
	if _, err = tx.Exec(ctx, `DELETE FROM lead_files WHERE id = $1`, id); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	_, _ = s.st.db.Exec(ctx, `DELETE FROM file_scans WHERE file_id = $1`, id)
	writeJSON(q.w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// ---- storage against the plan (D257, D289) ----

type storageLimit struct {
	bytes int64 // -1: no limit
	at    time.Time
}

// fileStorageLimit is the agency's file storage in bytes from billing's entitlements (file_storage_mb), -1 when unlimited or when
// billing is not set up. Kept a minute.
func (s *server) fileStorageLimit(ctx context.Context, org string) (int64, error) {
	if s.storageLimitFn != nil {
		return s.storageLimitFn(ctx, org)
	}
	if s.cfg.billingURL == "" {
		return -1, nil
	}
	if v, ok := s.storageLimits.Load(org); ok && time.Since(v.(storageLimit).at) < time.Minute {
		return v.(storageLimit).bytes, nil
	}
	var out struct {
		Limits map[string]*int64 `json:"limits"`
	}
	if err := getJSON(ctx, s.cfg.billingURL+"/v1/orgs/"+org+"/entitlements", s.cfg.billingToken, &out); err != nil {
		return 0, err
	}
	limit := int64(-1)
	if mb := out.Limits["file_storage_mb"]; mb != nil {
		limit = *mb << 20
	}
	s.storageLimits.Store(org, storageLimit{limit, time.Now()})
	return limit, nil
}

// roomFor refuses a file that would take the agency past its plan's storage.
func (s *server) roomFor(ctx context.Context, sc scope, size int64) error {
	limit, err := s.fileStorageLimit(ctx, sc.orgID)
	if err != nil {
		return &apiError{http.StatusServiceUnavailable, "unavailable", "The agency's storage can't be checked right now. Try again in a moment."}
	}
	if limit < 0 {
		return nil
	}
	used, err := s.filesUsed(ctx, sc.orgID)
	if err != nil {
		return err
	}
	if used+size > limit {
		return &apiError{http.StatusPaymentRequired, "storage_full", fmt.Sprintf("The agency's file storage is full (%s of %s). Remove old files, or the owner can add storage.", megabytes(used), megabytes(limit))}
	}
	return nil
}

func (s *server) filesUsed(ctx context.Context, org string) (int64, error) {
	tx, err := s.st.begin(ctx, scope{orgID: org})
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var used int64
	err = tx.QueryRow(ctx, `SELECT coalesce(sum(size), 0)::bigint FROM lead_files WHERE scan <> 'infected'`).Scan(&used)
	return used, err
}

func megabytes(b int64) string {
	if b >= 1<<30 {
		return fmt.Sprintf("%.1f GB", float64(b)/(1<<30))
	}
	return fmt.Sprintf("%.1f MB", float64(b)/(1<<20))
}

// fileStorage answers GET /api/v1/files/storage: how much of the plan's file storage is used, for the owner and admins.
func (s *server) fileStorage(q *req) error {
	if !manages(q.sc) {
		return forbidden("The owner and admins see the agency's storage.")
	}
	ctx := q.r.Context()
	used, err := s.filesUsed(ctx, q.sc.orgID)
	if err != nil {
		return err
	}
	limit, err := s.fileStorageLimit(ctx, q.sc.orgID)
	if err != nil {
		return &apiError{http.StatusServiceUnavailable, "unavailable", "The agency's storage can't be checked right now. Try again in a moment."}
	}
	out := map[string]any{"used_bytes": used, "limit_bytes": nil}
	if limit >= 0 {
		out["limit_bytes"] = limit
	}
	writeJSON(q.w, http.StatusOK, out)
	return nil
}

// getJSON reads another Caller Whale service's answer.
func getJSON(ctx context.Context, url, token string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := aiHTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", url, res.Status)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(into)
}
