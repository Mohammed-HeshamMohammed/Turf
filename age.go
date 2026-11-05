package main

import (
	"net/http"
	"strings"
	"time"
)

// Caller Whale is for adults: a business and calling tool. The minimum age is checked from the date of birth a person gives when
// they sign up (or, for accounts made before this check or through Google or Apple, the first time they sign in afterwards).
const minimumAge = 18

// ageOn is the whole years between a birth date and a day.
func ageOn(birth, day time.Time) int {
	years := day.Year() - birth.Year()
	if day.Month() < birth.Month() || (day.Month() == birth.Month() && day.Day() < birth.Day()) {
		years--
	}
	return years
}

// parseBirthDate reads YYYY-MM-DD and answers the date, or the reason it is not accepted. The reason is safe to show.
func parseBirthDate(value string, now time.Time) (time.Time, error) {
	birth, err := time.Parse("2006-01-02", strings.TrimSpace(value))
	if err != nil {
		return time.Time{}, bad("Enter your date of birth.")
	}
	today := time.Date(now.UTC().Year(), now.UTC().Month(), now.UTC().Day(), 0, 0, 0, 0, time.UTC)
	if birth.After(today) || ageOn(birth, today) > 120 {
		return time.Time{}, bad("Enter your real date of birth.")
	}
	if ageOn(birth, today) < minimumAge {
		return time.Time{}, forbidden("You must be 18 or older to use Caller Whale.")
	}
	return birth, nil
}

// birthDateGiven says whether this person has already given a date of birth.
func (s *server) birthDateGiven(r *http.Request, id string) (bool, error) {
	var confirmed int64
	if err := s.db.QueryRow(r.Context(), "SELECT age_confirmed_at FROM users WHERE id = $1", id).Scan(&confirmed); err != nil {
		return false, err
	}
	return confirmed > 0, nil
}

// setBirthDate is the age check for an account that has not given a date yet. It can be done once.
func (s *server) setBirthDate(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var body struct {
		BirthDate string `json:"birth_date"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	birth, err := parseBirthDate(body.BirthDate, time.Now())
	if err != nil {
		return err
	}
	given, err := s.birthDateGiven(r, c.Sub)
	if err != nil {
		return err
	}
	if given {
		return bad("Your date of birth is already on file. Contact support to change it.")
	}
	if _, err := s.db.Exec(r.Context(), "UPDATE users SET birth_date = $1, age_confirmed_at = $2 WHERE id = $3", birth.Format("2006-01-02"), now(), c.Sub); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"age_confirmed": true})
	return nil
}
