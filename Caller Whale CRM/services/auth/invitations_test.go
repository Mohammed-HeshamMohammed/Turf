package main

import "testing"

func TestInvitationDeadlineIsOneHourFromCreation(t *testing.T) {
	created := int64(1_800_000_000)
	if got := invitationDeadline(created); got != created+3600 {
		t.Fatalf("invitation deadline = %d, want %d", got, created+3600)
	}
}
