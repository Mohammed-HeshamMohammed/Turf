package main

import "testing"

func TestAnnouncementClean(t *testing.T) {
	ok := announcement{Enabled: true, Message: " Sale ends Friday ", LinkLabel: "See plans", LinkURL: "/pricing", Tone: "promo"}
	if err := ok.clean(); err != nil || ok.Message != "Sale ends Friday" {
		t.Fatalf("a good announcement was refused: %v", err)
	}
	for name, a := range map[string]announcement{
		"on with no message": {Enabled: true, Tone: "info"},
		"bad tone":           {Message: "x", Tone: "loud"},
		"link without text":  {Message: "x", Tone: "info", LinkURL: "/pricing"},
		"script link":        {Message: "x", Tone: "info", LinkLabel: "go", LinkURL: "javascript:alert(1)"},
		"protocol-less link": {Message: "x", Tone: "info", LinkLabel: "go", LinkURL: "//evil.example"},
		"tab without a link": {Message: "x", Tone: "info", TabEnabled: true, TabText: "Go", TabURL: "javascript:1"},
		"tab without text":   {Message: "x", Tone: "info", TabEnabled: true, TabURL: "/signup"},
		"plain http link":    {Message: "x", Tone: "info", LinkLabel: "go", LinkURL: "http://example.com"},
	} {
		if err := a.clean(); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}
