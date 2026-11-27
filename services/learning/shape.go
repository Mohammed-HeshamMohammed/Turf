package main

// What the learning store keeps of a lead, and what it never keeps.
//
// Kept: keyed hashes of the phone and the email (one-way; the key is held only by the platform owners), the shape of the name (a person
// with so many words, or a company), the city, state and five-digit ZIP, how complete the row was, a few property facts from a fixed list,
// and later the flags people gave the lead. Never kept: the name, phone, email, street address or unit as written, coordinates, or any
// free text.

import (
	"crypto/hmac"
	"crypto/sha256"
	"strings"
	"unicode"
)

// hasher makes the keyed hashes. A different word goes in front of each kind of value, so a phone and an email can never collide.
type hasher struct{ key []byte }

// forOrg gives the hasher of one workspace: its key is derived from the master key and the workspace, so the same phone number hashes
// differently in every workspace and rows can never be matched across workspaces.
func (h hasher) forOrg(org string) hasher {
	return hasher{key: h.sum("workspace", org)}
}

func (h hasher) sum(kind, value string) []byte {
	m := hmac.New(sha256.New, h.key)
	m.Write([]byte(kind))
	m.Write([]byte{0})
	m.Write([]byte(value))
	return m.Sum(nil)
}

// phoneKey is the digits that identify a phone number: the last ten, so "(512) 555-0100" and "+1 512 555 0100" are the same. Under seven
// digits is not a phone number.
func phoneKey(phone string) string {
	var digits []rune
	for _, r := range phone {
		if unicode.IsDigit(r) {
			digits = append(digits, r)
		}
	}
	if len(digits) < 7 {
		return ""
	}
	if len(digits) > 10 {
		digits = digits[len(digits)-10:]
	}
	return string(digits)
}

func emailKey(email string) string {
	email = strings.ToLower(strings.TrimSpace(email))
	if at := strings.IndexByte(email, '@'); at < 1 || at == len(email)-1 || len(email) > 254 {
		return ""
	}
	return email
}

func (h hasher) phone(phone string) []byte {
	if k := phoneKey(phone); k != "" {
		return h.sum("phone", k)
	}
	return nil
}

func (h hasher) email(email string) []byte {
	if k := emailKey(email); k != "" {
		return h.sum("email", k)
	}
	return nil
}

var companyWords = map[string]bool{"llc": true, "inc": true, "corp": true, "co": true, "ltd": true, "lp": true, "llp": true, "trust": true, "estate": true,
	"holdings": true, "properties": true, "investments": true, "partners": true, "company": true, "bank": true, "association": true, "gmbh": true}

// nameShape says only what kind of name it was: "company", or "person:2" for a person written with two words.
func nameShape(name string) string {
	words := strings.FieldsFunc(strings.ToLower(name), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	if len(words) == 0 {
		return ""
	}
	for _, w := range words {
		if companyWords[w] {
			return "company"
		}
	}
	return "person:" + string(rune('0'+min(len(words), 9)))
}

// zip5 is the first five digits of a postal code (a five-digit area, not a street).
func zip5(zip string) string {
	var digits []rune
	for _, r := range zip {
		if unicode.IsDigit(r) {
			digits = append(digits, r)
		}
	}
	if len(digits) < 5 {
		return ""
	}
	return string(digits[:5])
}

// short is a place name or a code kept to a safe length and plain characters.
func short(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	var out []rune
	for _, r := range s {
		if unicode.IsLetter(r) || r == ' ' || r == '-' || r == '.' || r == '\'' {
			out = append(out, r)
		}
		if len(out) >= max {
			break
		}
	}
	return strings.TrimSpace(string(out))
}

// The property facts that may be kept, from the standard source columns. Nothing outside this list is stored, so a column that holds a name
// or a note in somebody's list cannot reach the store.
var detailKeys = map[string]bool{
	"bedrooms": true, "bathrooms": true, "living_sqft": true, "year_built": true, "lot_sqft": true, "lot_acres": true, "stories": true,
	"property_type": true, "land_use": true, "owner_occupied": true, "vacant": true, "ownership_months": true, "owner_type": true,
	"air_conditioning": true, "heating": true, "garage_type": true, "garage_sqft": true, "units": true,
}

func cleanDetails(in map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range in {
		v = strings.TrimSpace(v)
		if !detailKeys[k] || v == "" || len(v) > 40 {
			continue
		}
		// A fact is a number, a yes/no or a short label; anything with an @ or many digits in a row is not.
		if strings.Contains(v, "@") || longDigits(v) {
			continue
		}
		out[k] = v
	}
	return out
}

func longDigits(s string) bool {
	run := 0
	for _, r := range s {
		if unicode.IsDigit(r) {
			run++
			if run >= 7 {
				return true
			}
		} else {
			run = 0
		}
	}
	return false
}

// Flags are what callers and users decided about a lead. Fixed names, short values.
var flagKeys = map[string]bool{"stage": true, "verdict": true, "do_not_call": true, "call_outcome": true, "priority": true, "interested": true}

func cleanFlags(in map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range in {
		v = strings.TrimSpace(v)
		if flagKeys[k] && v != "" && len(v) <= 40 && !strings.Contains(v, "@") && !longDigits(v) {
			out[k] = v
		}
	}
	return out
}
