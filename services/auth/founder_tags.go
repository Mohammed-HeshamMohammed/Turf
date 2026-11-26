package main

import (
	"context"
	"log"
)

// The platform owner is Name#Owner and the cofounder Name#Co-Owner, and nobody else can be either: the tags follow the two
// permanent roles authz keeps (one each), a chosen tag can never spell them (tagPattern has no O and no hyphen), and the
// database lets only settleFounderTag write them, for one person each (database_setup/0035_founder_tags.sql).

const (
	ownerTag   = "Owner"
	coOwnerTag = "Co-Owner"
)

// founderTag is the tag a platform role carries, or "" for everyone else.
func founderTag(platformRole string) string {
	switch platformRole {
	case "owner":
		return ownerTag
	case "cofounder":
		return coOwnerTag
	}
	return ""
}

func isFounderTag(tag string) bool { return tag == ownerTag || tag == coOwnerTag }

// settleFounderTag gives the owner and cofounder their tag, and takes it back from anyone who no longer has the role (they get a
// new random tag). Called with the role authz just gave; quiet on failure, the next visit tries again.
func (s *server) settleFounderTag(ctx context.Context, userID, platformRole string) {
	want := founderTag(platformRole)
	var current string
	if err := s.db.QueryRow(ctx, "SELECT tag FROM users WHERE id = $1", userID).Scan(&current); err != nil {
		return
	}
	if current == want || (want == "" && !isFounderTag(current)) {
		return
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	// The database's guard lets this one update through for this one person (it is reset when the transaction ends).
	if _, err := tx.Exec(ctx, "SELECT set_config('callerwhale.founder_tag', $1, true)", userID); err != nil {
		return
	}
	var next any = want
	if want == "" {
		next = nil // the database gives a new random tag
	}
	if _, err := tx.Exec(ctx, "UPDATE users SET tag = $2 WHERE id = $1", userID, next); err != nil {
		log.Printf("WARN could not set the founder tag of %s: %v", userID, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		log.Printf("WARN could not set the founder tag of %s: %v", userID, err)
	}
}

// platformStaff is Caller Whale's own staff with the run of the platform pages: the owner, the cofounder and system admins (D391).
// Testers are not: they only try features early. The founder tags stay with the owner and cofounder alone.
func platformStaff(platformRole string) bool {
	return platformRole == "owner" || platformRole == "cofounder" || platformRole == "system_admin"
}
