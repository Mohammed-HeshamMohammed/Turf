package main

// The announcement banner at the top of the public site. Anyone may read it; platform staff (owner, cofounder, system admin, after a
// second step) change it from the dashboard.

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type announcement struct {
	Enabled   bool   `json:"enabled"`
	Message   string `json:"message"`
	LinkLabel string `json:"link_label"`
	LinkURL   string `json:"link_url"`
	Tone      string `json:"tone"` // info, promo, warning
	UpdatedAt int64  `json:"updated_at"`

	// The tab on the right edge of the home page hero.
	TabEnabled bool   `json:"tab_enabled"`
	TabText    string `json:"tab_text"`
	TabURL     string `json:"tab_url"`
}

var announcementTones = map[string]bool{"info": true, "promo": true, "warning": true}

// validLink is true for a page on this site (starts with one /) or an https address.
func validLink(u string) bool {
	return (strings.HasPrefix(u, "/") && !strings.HasPrefix(u, "//")) || strings.HasPrefix(u, "https://")
}

// clean trims the text and refuses anything the banner should not show. A link may only go to a page on this site or to https.
func (a *announcement) clean() error {
	a.Message = strings.TrimSpace(a.Message)
	a.LinkLabel = strings.TrimSpace(a.LinkLabel)
	a.LinkURL = strings.TrimSpace(a.LinkURL)
	a.TabText = strings.TrimSpace(a.TabText)
	a.TabURL = strings.TrimSpace(a.TabURL)
	switch {
	case utf8.RuneCountInString(a.Message) > 200:
		return bad("The message can be up to 200 characters.")
	case a.Enabled && a.Message == "":
		return bad("Write the message before turning the banner on.")
	case !announcementTones[a.Tone]:
		return bad("Choose a style: info, promo or warning.")
	case utf8.RuneCountInString(a.LinkLabel) > 30:
		return bad("The link text can be up to 30 characters.")
	case a.LinkURL != "" && a.LinkLabel == "":
		return bad("Add the text for the link.")
	case a.LinkURL != "" && !validLink(a.LinkURL):
		return bad("The link must start with / (a page on this site) or https://.")
	case len(a.LinkURL) > 300 || len(a.TabURL) > 300:
		return bad("The link is too long.")
	case utf8.RuneCountInString(a.TabText) > 30:
		return bad("The tab text can be up to 30 characters.")
	case a.TabEnabled && (a.TabText == "" || !validLink(a.TabURL)):
		return bad("The side tab needs its text and a link that starts with / or https://.")
	}
	if a.LinkURL == "" {
		a.LinkLabel = ""
	}
	return nil
}

func (s *server) getAnnouncement(w http.ResponseWriter, r *http.Request) error {
	a := announcement{Tone: "info", TabEnabled: true, TabText: "Start for free", TabURL: "/signup"}
	var enabled, tab int
	err := s.db.QueryRow(r.Context(), "SELECT enabled, message, link_label, link_url, tone, updated_at, tab_enabled, tab_text, tab_url FROM site_announcement WHERE id = 'site'").
		Scan(&enabled, &a.Message, &a.LinkLabel, &a.LinkURL, &a.Tone, &a.UpdatedAt, &tab, &a.TabText, &a.TabURL)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		a.TabEnabled = tab == 1
	}
	a.Enabled = enabled == 1
	writeJSON(w, http.StatusOK, a)
	return nil
}

func (s *server) setAnnouncement(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.staffActor(r, false); err != nil {
		return err
	}
	var a announcement
	if err := readJSON(w, r, &a); err != nil {
		return err
	}
	if err := a.clean(); err != nil {
		return err
	}
	enabled := 0
	if a.Enabled {
		enabled = 1
	}
	tab := 0
	if a.TabEnabled {
		tab = 1
	}
	a.UpdatedAt = now()
	if _, err := s.db.Exec(r.Context(), `INSERT INTO site_announcement (id, enabled, message, link_label, link_url, tone, updated_at, tab_enabled, tab_text, tab_url) VALUES ('site', $1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (id) DO UPDATE SET enabled = $1, message = $2, link_label = $3, link_url = $4, tone = $5, updated_at = $6, tab_enabled = $7, tab_text = $8, tab_url = $9`,
		enabled, a.Message, a.LinkLabel, a.LinkURL, a.Tone, a.UpdatedAt, tab, a.TabText, a.TabURL); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, a)
	return nil
}
