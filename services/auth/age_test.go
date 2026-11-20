package main

import (
	"testing"
	"time"
)

func TestAgeCheck(t *testing.T) {
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		birth string
		ok    bool
	}{
		{"2008-11-05", true},  // turns 18 today
		{"2008-11-06", false}, // turns 18 tomorrow
		{"1990-02-30", false}, // not a date
		{"", false},
		{"2027-01-01", false},  // in the future
		{"1890-01-01", false},  // over 120
		{" 2000-06-15 ", true}, // spaces are ignored
		{"15/06/2000", false},  // only YYYY-MM-DD
	}
	for _, c := range cases {
		_, err := parseBirthDate(c.birth, now)
		if (err == nil) != c.ok {
			t.Errorf("%q: accepted=%v, want %v (%v)", c.birth, err == nil, c.ok, err)
		}
	}
	if _, err := parseBirthDate("2010-01-01", now); err == nil || err.Error() == "" {
		t.Fatal("a minor must be refused with a reason")
	}
}

func TestSignUpRecordsTheAgeCheckAndItIsOnlyDoneOnce(t *testing.T) {
	w := newWorld(t)
	account := w.signUp("age@example.com")
	me := w.call("GET", "/v1/me", nil, account.access())
	if me.body["age_confirmed"] != true {
		t.Fatalf("a sign-up with a date of birth is age-checked: %v", me.body)
	}
	if again := w.call("POST", "/v1/me/birth-date", map[string]any{"birth_date": "1990-01-01"}, account.access()); again.status != 400 {
		t.Fatalf("the date cannot be given twice: %d %v", again.status, again.body)
	}
	if anonymous := w.call("POST", "/v1/me/birth-date", map[string]any{"birth_date": "1990-01-01"}, ""); anonymous.status != 401 {
		t.Fatalf("signed out: %d", anonymous.status)
	}
}

func TestWorkProfileAnswersAreChecked(t *testing.T) {
	good := workProfile{Role: "lead_buyer", TeamSize: "2_10", Uses: []string{"cold_calling", "cold_calling", "managing_deals"}}
	cleaned, err := cleanWorkProfile(good)
	if err != nil || len(cleaned.Uses) != 2 {
		t.Fatalf("a normal answer is accepted and repeats are dropped: %v %v", cleaned, err)
	}
	for name, p := range map[string]workProfile{
		"unknown role":     {Role: "pirate", TeamSize: "just_me", Uses: []string{"cold_calling"}},
		"unknown size":     {Role: "solo_caller", TeamSize: "huge", Uses: []string{"cold_calling"}},
		"no uses":          {Role: "solo_caller", TeamSize: "just_me"},
		"unknown use":      {Role: "solo_caller", TeamSize: "just_me", Uses: []string{"magic"}},
		"other needs text": {Role: "other", TeamSize: "just_me", Uses: []string{"cold_calling"}},
	} {
		if _, err := cleanWorkProfile(p); err == nil {
			t.Errorf("%s should be refused", name)
		}
	}
	if _, err := cleanWorkProfile(workProfile{Role: "other", TeamSize: "just_me", Uses: []string{"cold_calling"}, Other: "Roofing leads"}); err != nil {
		t.Fatalf("other with a description is fine: %v", err)
	}
}
