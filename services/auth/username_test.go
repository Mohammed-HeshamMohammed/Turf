package main

import "testing"

func TestUsernameFrom(t *testing.T) {
	for _, c := range []struct{ name, email, want string }{
		{"Mohammed Hesham", "m@x.com", "mohammed-hesham"},
		{"  José  Álvarez!! ", "j@x.com", "jos-lvarez"},
		{"", "sara.lee@x.com", "sara-lee"},
		{"Dashboard", "d@x.com", "dashboard-user"},
		{"Al", "al@x.com", "al-user"},
		{"A very long display name that goes on and on", "a@x.com", "a-very-long-display-name"},
	} {
		if got := usernameFrom(c.name, c.email); got != c.want {
			t.Errorf("%q: got %q, want %q", c.name, got, c.want)
		}
		if !usernameShape.MatchString(usernameFrom(c.name, c.email)) {
			t.Errorf("%q: %q is not a valid username", c.name, usernameFrom(c.name, c.email))
		}
	}
}

func TestUsernameShape(t *testing.T) {
	for name, want := range map[string]bool{"abc": true, "a-b-c": true, "mohammed-hesham-2": true, "ab": false, "-ab": false, "ab-": false, "a--b": false, "Abc": false, "a_b": false, "a b": false} {
		if usernameShape.MatchString(name) != want {
			t.Errorf("%q: want %v", name, want)
		}
	}
}
