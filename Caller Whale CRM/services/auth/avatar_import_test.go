package main

import "testing"

func TestGooglePictureHost(t *testing.T) {
	for raw, want := range map[string]bool{
		"https://lh3.googleusercontent.com/a/abc=s96-c":    true,
		"https://googleusercontent.com/a/abc":              true,
		"http://lh3.googleusercontent.com/a/abc":           false,
		"https://evil.example/lh3.googleusercontent.com/a": false,
		"https://googleusercontent.com.evil.example/a":     false,
		"https://user@lh3.googleusercontent.com/a":         false,
		"":                                                 false,
	} {
		if got := googlePictureHost(raw); got != want {
			t.Errorf("%q: got %v, want %v", raw, got, want)
		}
	}
}

func TestFetchGooglePictureRefusesOtherHosts(t *testing.T) {
	if got := fetchGooglePicture(t.Context(), "https://169.254.169.254/latest/meta-data"); got != "" {
		t.Fatalf("fetched a picture from a host that is not Google's: %q", got)
	}
}
