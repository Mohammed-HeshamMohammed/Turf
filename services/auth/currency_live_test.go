package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"
)

// isoXML writes a list in SIX's format from a table of digits.
func isoXML(digits map[string]int) string {
	codes := make([]string, 0, len(digits))
	for code := range digits {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?><ISO_4217 Pblshd="2027-01-15"><CcyTbl>`)
	for _, code := range codes {
		fmt.Fprintf(&b, "<CcyNtry><CtryNm>X</CtryNm><CcyNm>X</CcyNm><Ccy>%s</Ccy><CcyNbr>1</CcyNbr><CcyMnrUnts>%d</CcyMnrUnts></CcyNtry>", code, digits[code])
	}
	// entries that must be ignored: a metal, a funds code, one with no minor unit
	b.WriteString(`<CcyNtry><Ccy>XAU</Ccy><CcyMnrUnts>N.A.</CcyMnrUnts></CcyNtry><CcyNtry><Ccy>USN</Ccy><CcyMnrUnts>2</CcyMnrUnts></CcyNtry><CcyNtry><Ccy>XYZ</Ccy><CcyMnrUnts>N.A.</CcyMnrUnts></CcyNtry>`)
	b.WriteString(`</CcyTbl></ISO_4217>`)
	return b.String()
}

// cldrJSON writes CLDR's format: every country with one current currency, plus the history of a few.
func cldrJSON(regions map[string]string) string {
	var parts []string
	for region, code := range regions {
		parts = append(parts, fmt.Sprintf(`%q: [{%q: {"_from": "2000-01-01"}}]`, region, code))
	}
	// Croatia: the euro now, the kuna ended. Zimbabwe: two in use, the newer wins. A region in the future, a non-tender one, a numeric region.
	parts = append(parts,
		`"HR": [{"EUR": {"_from": "2023-01-01"}}, {"HRK": {"_from": "1994-05-30", "_to": "2023-01-14"}}]`,
		`"ZW": [{"USD": {"_from": "2009-04-12"}}, {"ZWG": {"_from": "2024-06-25"}}, {"ZWL": {"_from": "2009-02-02", "_to": "2024-08-31"}}]`,
		`"NZ": [{"NZD": {"_from": "1967-07-10"}}, {"USD": {"_tender": "false"}}]`,
		`"PL": [{"PLN": {"_from": "1995-01-01"}}, {"EUR": {"_from": "2999-01-01"}}]`,
		`"001": [{"USD": {"_from": "1792-01-01"}}]`)
	return `{"supplemental": {"version": {"_cldrVersion": "99"}, "currencyData": {"region": {` + strings.Join(parts, ",") + `}}}}`
}

func TestTheStandardsAreReadByTheirOwnRules(t *testing.T) {
	digits, published, err := parseISO([]byte(isoXML(isoMinorUnits)))
	if err != nil || published != "2027-01-15" {
		t.Fatalf("%v %q", err, published)
	}
	for _, ignored := range []string{"XAU", "USN", "XYZ"} {
		if _, ok := digits[ignored]; ok {
			t.Errorf("%s is not money and was kept", ignored)
		}
	}
	if digits["JPY"] != 0 || digits["KWD"] != 3 || digits["USD"] != 2 {
		t.Errorf("decimals: %d %d %d", digits["JPY"], digits["KWD"], digits["USD"])
	}
	regions := map[string]string{}
	for r, c := range regionCurrency {
		regions[r] = c
	}
	got, version, err := parseCLDR([]byte(cldrJSON(regions)), digits, "2026-11-05")
	if err != nil || version != "99" {
		t.Fatalf("%v %q", err, version)
	}
	for region, want := range map[string]string{"HR": "EUR", "ZW": "ZWG", "NZ": "NZD", "PL": "PLN"} {
		if got[region] != want {
			t.Errorf("%s: got %q, wanted %q", region, got[region], want)
		}
	}
	if _, ok := got["001"]; ok {
		t.Error("a region that is not a country was kept")
	}
	// A standard that is cut short must not replace good tables.
	if _, _, err := parseISO([]byte(`<ISO_4217><CcyTbl></CcyTbl></ISO_4217>`)); err == nil {
		t.Error("an empty ISO list was accepted")
	}
	if _, _, err := parseCLDR([]byte(`{"supplemental":{"currencyData":{"region":{"EG":[{"EGP":{}}]}}}}`), digits, "2026-11-05"); err == nil {
		t.Error("a CLDR file with a handful of countries was accepted")
	}
}

func TestTheTablesFollowTheStandardsWhileTheServerRuns(t *testing.T) {
	// The fake standards say Egypt has moved to the euro and that a made-up currency exists: if the server is really live, it follows.
	digits := map[string]int{}
	for code, d := range isoMinorUnits {
		digits[code] = d
	}
	digits["QQQ"] = 3
	regions := map[string]string{}
	for r, c := range regionCurrency {
		regions[r] = c
	}
	regions["EG"] = "EUR"
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".xml") {
			_, _ = w.Write([]byte(isoXML(digits)))
			return
		}
		_, _ = w.Write([]byte(cldrJSON(regions)))
	}))
	defer source.Close()
	old := currencySources
	currencySources.iso, currencySources.cldr = source.URL+"/list.xml", source.URL+"/currency.json"
	liveCurrency.Store(nil)
	nextAttempt.Store(0)
	defer func() { currencySources = old; liveCurrency.Store(nil); nextAttempt.Store(0) }()

	if isCurrency("QQQ") || regionCurrency["EG"] != "EGP" {
		t.Fatal("the snapshot should not know about tomorrow")
	}
	refreshCurrencyTables(context.Background())
	if !isCurrency("QQQ") || digits3("QQQ") != 3 {
		t.Fatal("a new currency in the standard was not picked up")
	}
	if got := currentTables().regions["EG"]; got != "EUR" {
		t.Fatalf("a country that changed currency was not picked up: %q", got)
	}
	// A day later the source is down: the last good tables stay.
	live := liveCurrency.Load()
	live.fetched = time.Now().Add(-25 * time.Hour)
	source.Close()
	refreshCurrencyTables(context.Background())
	if !isCurrency("QQQ") {
		t.Fatal("a failed fetch replaced good tables")
	}
	if nextAttempt.Load() <= time.Now().Unix() {
		t.Error("a failed fetch should wait before trying again")
	}
}

func digits3(code string) int { return digits(code) }
