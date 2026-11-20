package main

import "testing"

// The CRM keeps the agency's name here so auth can say on an invitation which agency it comes from.
func TestTheCRMNamesTheAgencyAndAuthReadsIt(t *testing.T) {
	h := newHarness(t)
	if code, _ := h.call(authToken, "GET", "/v1/orgs/"+org1, nil); code != 404 {
		t.Fatalf("a workspace never opened is not found: %d", code)
	}
	h.opened()
	if code, _ := h.call(authToken, "PUT", "/v1/orgs/"+org1+"/name", map[string]any{"name": "Fake agency"}); code != 403 {
		t.Fatalf("auth cannot name an agency, only the CRM can: %d", code)
	}
	for _, bad := range []string{"", "   ", "two\nlines"} {
		if code, _ := h.call(coreToken, "PUT", "/v1/orgs/"+org1+"/name", map[string]any{"name": bad}); code != 400 {
			t.Fatalf("name %q is refused: %d", bad, code)
		}
	}
	if code, out := h.call(coreToken, "PUT", "/v1/orgs/"+org1+"/name", map[string]any{"name": "  Blue Door Homes "}); code != 200 {
		t.Fatalf("the CRM names the agency: %d %v", code, out)
	}
	code, out := h.call(authToken, "GET", "/v1/orgs/"+org1, nil)
	if code != 200 || out["name"] != "Blue Door Homes" || out["owner_id"] != ownerID {
		t.Fatalf("auth reads the name and owner: %d %v", code, out)
	}
	if code, _ := h.call(gatewayToken, "GET", "/v1/orgs/"+org1, nil); code != 403 {
		t.Fatalf("the gateway only checks, it does not read: %d", code)
	}
}
