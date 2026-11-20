package main

import "testing"

func TestInvitationDeadlineIsOneHourForStaffAndTheAgencysDaysForAWorkspace(t *testing.T) {
	created := int64(1_800_000_000)
	if got := invitationDeadline("platform", created, 7); got != created+3600 {
		t.Fatalf("platform invitation deadline = %d, want %d", got, created+3600)
	}
	if got := invitationDeadline("workspace", created, 7); got != created+7*24*3600 {
		t.Fatalf("workspace invitation deadline = %d, want %d", got, created+7*24*3600)
	}
	if got := invitationDeadline("workspace", created, 1); got != created+24*3600 {
		t.Fatalf("a one-day agency: %d", got)
	}
}
