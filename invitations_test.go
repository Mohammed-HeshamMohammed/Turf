package main

import "testing"

func TestInvitationDeadlineIsOneHourForStaffAndThreeDaysForAWorkspace(t *testing.T) {
	created := int64(1_800_000_000)
	if got := invitationDeadline("platform", created); got != created+3600 {
		t.Fatalf("platform invitation deadline = %d, want %d", got, created+3600)
	}
	if got := invitationDeadline("workspace", created); got != created+72*3600 {
		t.Fatalf("workspace invitation deadline = %d, want %d", got, created+72*3600)
	}
}
