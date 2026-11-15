package main

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Files on a lead: the Documents tab. Anyone who sees the lead sees its files (a client only the shared ones); whoever can edit the
// lead uploads them; the uploader or an editor removes them.

const maxFile = 10 << 20

var fileTypes = []string{
	"application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif", "text/plain", "text/csv",
	"application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

const fileColumns = `jsonb_build_object('id', f.id, 'lead_id', f.lead_id, 'name', f.name, 'mime', f.mime, 'size', f.size, 'visibility', f.visibility,
	'uploaded_by', f.uploaded_by, 'uploaded_label', f.uploaded_label, 'created_at', f.created_at)`

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
	files, err := queryJSON(ctx, tx, `SELECT `+fileColumns+` FROM lead_files f WHERE f.lead_id = $1 AND (NOT cw_external() OR f.visibility = 'shared') ORDER BY f.created_at DESC`, id)
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"files": files, "can_upload": editable})
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
		return bad("Upload a PDF, an image, a text or CSV file, or a Word or Excel document.")
	}
	body, err := io.ReadAll(http.MaxBytesReader(q.w, q.r.Body, maxFile+1))
	if err != nil || len(body) > maxFile {
		return bad("A file can be up to 10 MB.")
	}
	if len(body) == 0 {
		return bad("That file is empty.")
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
	if !editable {
		return forbidden("Only someone who can edit this lead adds files to it.")
	}
	file, err := queryJSON(ctx, tx, `WITH f AS (INSERT INTO lead_files (org_id, lead_id, name, mime, size, visibility, uploaded_by, uploaded_label, body)
		VALUES (cw_org(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *) SELECT `+fileColumns+` FROM f`, id, name, kind, len(body), visibility, q.sc.userID, q.sc.label, body)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	q.w.Header().Set("Content-Type", "application/json")
	q.w.WriteHeader(http.StatusCreated)
	_, _ = q.w.Write(file[0])
	return nil
}

// fileFor finds a file the asker may see, and whether they may remove it.
func fileFor(tx pgx.Tx, q *req, id string) (lead, name, kind string, removable bool, body []byte, err error) {
	var uploader, visibility string
	err = tx.QueryRow(q.r.Context(), `SELECT f.lead_id::text, f.name, f.mime, f.uploaded_by::text, f.visibility, f.body FROM lead_files f WHERE f.id = $1`, id).
		Scan(&lead, &name, &kind, &uploader, &visibility, &body)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", false, nil, notFound("That file does not exist.")
	}
	if err != nil {
		return "", "", "", false, nil, err
	}
	seen, editable, err := editableLead(tx, q, lead)
	if err != nil {
		return "", "", "", false, nil, err
	}
	if !seen || (q.sc.external() && visibility != "shared") {
		return "", "", "", false, nil, notFound("That file does not exist.")
	}
	return lead, name, kind, editable || (uploader == q.sc.userID && !q.sc.external()), body, nil
}

// downloadFile answers GET /api/v1/files/{id}: the file itself.
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
	_, name, kind, _, body, err := fileFor(tx, q, id)
	if err != nil {
		return err
	}
	q.w.Header().Set("Content-Type", kind)
	q.w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	q.w.Header().Set("X-Content-Type-Options", "nosniff")
	q.w.Header().Set("Cache-Control", "private, no-store")
	_, _ = q.w.Write(body)
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
	_, _, _, removable, _, err := fileFor(tx, q, id)
	if err != nil {
		return err
	}
	if !removable {
		return forbidden("Only whoever added the file, or someone who can edit the lead, removes it.")
	}
	if _, err = tx.Exec(ctx, `DELETE FROM lead_files WHERE id = $1`, id); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"ok": true})
	return nil
}
