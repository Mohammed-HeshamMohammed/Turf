package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestFilesOnALeadAreKeptAndOnlyForThoseWhoSeeIt(t *testing.T) {
	e := newEnv(t)
	e.seed()
	lead := newID(t)
	e.want(e.opWith(alice, orgA, "lead.create", map[string]any{"id": lead, "name": "Docs lead", "assignee_id": alice}, newID(t)), "applied")
	pdf := http.Header{"Content-Type": {"application/pdf"}}
	if status, _ := e.raw(alice, orgA, "POST", "/api/v1/leads/"+lead+"/files?name=x.exe", []byte("MZ"), http.Header{"Content-Type": {"application/x-msdownload"}}); status != 400 {
		t.Fatalf("a program is not a document: %d", status)
	}
	status, raw := e.raw(alice, orgA, "POST", "/api/v1/leads/"+lead+"/files?name=contract.pdf&visibility=shared", []byte("%PDF-1.4 hello"), pdf)
	if status != 201 {
		t.Fatalf("upload: %d %s", status, raw)
	}
	var file map[string]any
	_ = json.Unmarshal(raw, &file)
	id, _ := file["id"].(string)
	if file["name"] != "contract.pdf" || file["visibility"] != "shared" || file["size"] != 14.0 {
		t.Fatalf("stored: %v", file)
	}
	_, list := e.call(alice, orgA, "GET", "/api/v1/leads/"+lead+"/files", nil)
	if files, _ := list["files"].([]any); len(files) != 1 || list["can_upload"] != true {
		t.Fatalf("list: %v", list)
	}
	if status, body := e.raw(alice, orgA, "GET", "/api/v1/files/"+id, nil, nil); status != 200 || string(body) != "%PDF-1.4 hello" {
		t.Fatalf("download: %d %q", status, body)
	}
	// A caller who does not hold the lead neither sees nor downloads its files.
	if status, _ := e.call(bob, orgA, "GET", "/api/v1/leads/"+lead+"/files", nil); status != 404 {
		t.Errorf("another caller lists them: %d", status)
	}
	if status, _ := e.raw(bob, orgA, "GET", "/api/v1/files/"+id, nil, nil); status != 404 {
		t.Errorf("another caller downloads it: %d", status)
	}
	if status, _ := e.call(alice, orgA, "DELETE", "/api/v1/files/"+id, nil); status != 200 {
		t.Fatalf("remove: %d", status)
	}
	if _, list = e.call(alice, orgA, "GET", "/api/v1/leads/"+lead+"/files", nil); len(list["files"].([]any)) != 0 {
		t.Fatalf("still listed: %v", list)
	}
}
