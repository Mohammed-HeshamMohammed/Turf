package main

import (
	"strings"
	"testing"
)

func TestACallerMayHoldTwoTokensWhileOneIsReplaced(t *testing.T) {
	old, newer, third := strings.Repeat("o", 40), strings.Repeat("n", 40), strings.Repeat("t", 40)
	tokens, err := parseTokens("core-api=" + old + ",core-api=" + newer)
	if err != nil || tokens[old] != "core-api" || tokens[newer] != "core-api" {
		t.Fatalf("got %v, %v", tokens, err)
	}
	if _, err := parseTokens("core-api=" + old + ",core-api=" + newer + ",core-api=" + third); err == nil {
		t.Fatal("a third token for one caller was accepted")
	}
	if _, err := parseTokens("core-api=" + old + ",billing=" + old); err == nil {
		t.Fatal("two callers sharing a token was accepted")
	}
}
