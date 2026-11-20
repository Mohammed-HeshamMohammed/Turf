package main

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// validateNewPassword is the account-password policy. It is only for new passwords, never for sign-in attempts.
func validateNewPassword(value string) error {
	var missing []string
	if n := utf8.RuneCountInString(value); n < 8 || n > 4096 {
		missing = append(missing, "8–4096 characters")
	}
	var upper, lower, digit, special bool
	for _, c := range value {
		switch {
		case c >= 'A' && c <= 'Z':
			upper = true
		case c >= 'a' && c <= 'z':
			lower = true
		case c >= '0' && c <= '9':
			digit = true
		case strings.ContainsRune("^$*.[]{}()?\"!@#%&/\\,><':;|_~`=+-", c):
			special = true
		}
	}
	if !upper {
		missing = append(missing, "an uppercase letter (A–Z)")
	}
	if !lower {
		missing = append(missing, "a lowercase letter (a–z)")
	}
	if !digit {
		missing = append(missing, "a number (0–9)")
	}
	if !special {
		missing = append(missing, "a special character, such as !, @ or #")
	}
	if len(missing) == 0 {
		return nil
	}
	return bad("Password needs " + strings.Join(missing, ", ") + ".")
}

// normalEmail trims and lower-cases an address and checks its shape.
func normalEmail(email string) (string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	local, domain, found := strings.Cut(email, "@")
	ok := len(email) <= 254 && found && local != "" && strings.Contains(domain, ".") && !strings.HasPrefix(domain, ".") && !strings.HasSuffix(domain, ".")
	if ok && strings.IndexFunc(email, unicode.IsSpace) < 0 {
		return email, nil
	}
	return "", bad("Enter a valid email address.")
}
