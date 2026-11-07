package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"slices"
	"testing"
)

// Runs crm-core's authz client against a REAL authz service, so its idea of the answers is checked and not only what it was written
// to expect. Needs CRM_TEST_AUTHZ_URL and CRM_TEST_AUTHZ_TOKEN (a "core-api" token of that authz); skipped without them.
func TestTheRealAuthzAnswersAsTheClientExpects(t *testing.T) {
	url, token := os.Getenv("CRM_TEST_AUTHZ_URL"), os.Getenv("CRM_TEST_AUTHZ_TOKEN")
	if url == "" || token == "" {
		t.Skip("set CRM_TEST_AUTHZ_URL and CRM_TEST_AUTHZ_TOKEN to run this against a real authz")
	}
	const owner, org = "44444444-4444-4444-8444-444444444444", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	ctx := context.Background()
	// A workspace opens with its owner, as the auth service does when it gives someone a membership.
	body, _ := json.Marshal(map[string]string{"user_id": owner, "role": "owner"})
	req, _ := http.NewRequest(http.MethodPut, url+"/v1/orgs/"+org+"/owner", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != 200 {
		t.Fatalf("opening the workspace: %v %v", res, err)
	}

	a := newAuthz(url, token, 0)
	people, err := a.people(ctx, owner)
	if err != nil || len(people.Workspaces) != 1 || people.Workspaces[0].OrgID != org || !people.Workspaces[0].BusinessOwner || !slices.Contains(people.Workspaces[0].Roles, "owner") {
		t.Fatalf("people: %+v %v", people, err)
	}
	g, err := a.grant(ctx, owner, org, true)
	if err != nil || !g.Allowed || !slices.Contains(g.Scopes, "organization") || !slices.Contains(g.Capabilities, "import") || !slices.Contains(g.Capabilities, "finance") {
		t.Fatalf("grant for the owner: %+v %v", g, err)
	}
	if accessRevision(g) == 0 {
		t.Fatal("an access revision comes out of what the owner holds")
	}
	// Someone who is not in the workspace is refused with a code, and not an error.
	stranger, err := a.grant(ctx, "55555555-5555-4555-8555-555555555555", org, true)
	if err != nil || stranger.Allowed || stranger.Code != "not_member" {
		t.Fatalf("a stranger: %+v %v", stranger, err)
	}
	members, err := a.members(ctx, org)
	if err != nil || len(members) != 1 || members[0].UserID != owner {
		t.Fatalf("members: %+v %v", members, err)
	}
	// A wrong token is told apart from the service being down.
	if _, err = newAuthz(url, "wrong-token-wrong-token-wrong-token-wrong", 0).people(ctx, owner); err == nil {
		t.Fatal("a wrong token must be refused")
	}
}
