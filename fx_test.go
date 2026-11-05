package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Tests never reach the real standards: the background refresh does nothing unless a test calls refreshCurrencyTables itself.
func init() { startCurrencyRefresh = func() {} }

// a source with enough real currencies, some coins that must be ignored, and one rate that makes no sense
func fakeSource(t *testing.T, calls *int, fail *bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls++
		if *fail {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		usd := map[string]float64{"eur": 0.9, "egp": 50, "jpy": 150, "kwd": 0.3, "gbp": 0.75, "btc": 0.00001, "eth": 0.0003, "zzz": 5, "aud": -1}
		n := 0
		for code := range isoMinorUnits { // pad with the real codes so the source looks complete
			if _, ok := usd[lower(code)]; !ok {
				usd[lower(code)] = float64(2 + n%7)
				n++
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"date": "2026-11-05", "usd": usd})
	}))
}

func lower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func TestRatesKeepRealCurrenciesOnlyAndAreReusedForSixHours(t *testing.T) {
	calls, fail := 0, false
	source := fakeSource(t, &calls, &fail)
	defer source.Close()
	old := fxSources
	fxSources = []string{source.URL}
	defer func() { fxSources = old }()

	var cache fxCache
	table := cache.rates(context.Background())
	if table == nil || table.Rates["USD"] != 1 || table.Rates["EUR"] != 0.9 || table.AsOf != "2026-11-05" {
		t.Fatalf("table: %+v", table)
	}
	for _, notACurrency := range []string{"BTC", "ETH", "ZZZ"} {
		if _, ok := table.Rates[notACurrency]; ok {
			t.Errorf("%s is not a currency but was kept", notACurrency)
		}
	}
	if table.Rates["AUD"] == -1 {
		t.Error("a negative rate was kept")
	}
	cache.rates(context.Background())
	if calls != 1 {
		t.Fatalf("the source was asked %d times; the rates should be kept", calls)
	}
	// Six hours later the source is down: the last good rates are still served.
	cache.table.fetched = time.Now().Add(-7 * time.Hour)
	fail = true
	if again := cache.rates(context.Background()); again == nil || again.Rates["EUR"] != 0.9 {
		t.Fatalf("the last good rates should be served while the source is down: %+v", again)
	}
}

func TestNoRatesAtAllIsKnownNotGuessed(t *testing.T) {
	calls, fail := 0, true
	source := fakeSource(t, &calls, &fail)
	defer source.Close()
	old := fxSources
	fxSources = []string{source.URL}
	defer func() { fxSources = old }()
	var cache fxCache
	if cache.rates(context.Background()) != nil {
		t.Fatal("rates appeared from nowhere")
	}
	var none *fxTable
	if _, ok := none.convert(100, "EUR", "USD"); ok {
		t.Error("converted with no rates")
	}
	if minor, ok := none.convert(100, "USD", "USD"); !ok || minor != 100 {
		t.Error("the same currency needs no rates")
	}
}

func TestAmountsConvertByTheirOwnDecimals(t *testing.T) {
	table := &fxTable{Rates: map[string]float64{"USD": 1, "EUR": 0.9, "EGP": 50, "JPY": 150, "KWD": 0.3}}
	for _, c := range []struct {
		minor    int64
		from, to string
		want     int64
	}{
		{10000, "USD", "EUR", 9000},   // 100.00 dollars is 90.00 euros
		{9000, "EUR", "USD", 10000},   // and back
		{10000, "USD", "JPY", 15000},  // yen have no minor unit: 100.00 dollars is 15,000 yen
		{15000, "JPY", "USD", 10000},  // 15,000 yen is 100.00 dollars
		{10000, "USD", "KWD", 30000},  // dinars have three decimals: 100.00 dollars is 30.000 dinars
		{10000, "USD", "EGP", 500000}, // 100.00 dollars is 5,000.00 pounds (500,000 piastres)
	} {
		got, ok := table.convert(c.minor, c.from, c.to)
		if !ok || got != c.want {
			t.Errorf("%d %s to %s: got %d (%v), want %d", c.minor, c.from, c.to, got, ok, c.want)
		}
	}
	if _, ok := table.convert(100, "USD", "ZAR"); ok {
		t.Error("converted into a currency with no rate")
	}
	if minorOf(8_500, "USD") != 1 || minorOf(1_500_000, "JPY") != 2 || minorOf(1_234_000, "KWD") != 1234 {
		t.Errorf("minorOf: %d %d %d", minorOf(8_500, "USD"), minorOf(1_500_000, "JPY"), minorOf(1_234_000, "KWD"))
	}
}

func TestCostsAndRatesInAnotherCurrencyAreCountedAtTodaysRate(t *testing.T) {
	at := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	fx := &fxTable{AsOf: "2026-11-05", Rates: map[string]float64{"USD": 1, "EUR": 0.5, "EGP": 50}}
	costs := []costItem{
		{Label: "Server in euros", Category: "hosting", AmountMinor: 2000, Currency: "EUR", Interval: "monthly"}, // 20.00 euros = 40.00 dollars
		{Label: "Designer", Category: "other", AmountMinor: 9999, Currency: "ZAR", Interval: "monthly"},          // no rate: left out
	}
	rates := []rateItem{{Kind: "minute", RateMicros: 4000, Currency: "EUR"}} // 0.004 euros a minute = 0.008 dollars
	f := financeFrom(sample(t), costs, rates, fx, "", at)
	if f.MonthlyCostsMinor != 4000 || f.Converted != 2 || f.OtherCurrency != 1 || f.FXAsOf != "2026-11-05" {
		t.Fatalf("converted %d, left out %d, monthly costs %d, as of %q", f.Converted, f.OtherCurrency, f.MonthlyCostsMinor, f.FXAsOf)
	}
	// 1,200 minutes at 0.008 dollars is 9.60 dollars.
	if f.Variable.VoipMinor != 960 {
		t.Fatalf("minutes cost %d", f.Variable.VoipMinor)
	}
	// Without rates the euro cost is left out, as before.
	plain := financeFrom(sample(t), costs, rates, nil, "", at)
	if plain.MonthlyCostsMinor != 0 || plain.Converted != 0 || plain.OtherCurrency != 3 || plain.Variable.VoipMinor != 0 {
		t.Fatalf("without rates: %+v", plain)
	}
}

func TestThePublicRatesAnswerNeedsNoSignIn(t *testing.T) {
	calls, fail := 0, false
	source := fakeSource(t, &calls, &fail)
	defer source.Close()
	old := fxSources
	fxSources = []string{source.URL}
	defer func() { fxSources = old }()
	s := &server{}
	rec := httptest.NewRecorder()
	if err := s.publicFX(rec, httptest.NewRequest(http.MethodGet, "/v1/fx", nil)); err != nil {
		t.Fatal(err)
	}
	var got fxTable
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil || got.Base != "USD" || got.Rates["EUR"] != 0.9 {
		t.Fatalf("%v %+v", err, got)
	}
	if rec.Header().Get("Cache-Control") != "private, max-age=3600" {
		t.Errorf("rates may be kept by the browser for an hour, not shared: %q", rec.Header().Get("Cache-Control"))
	}
}

func TestTheVisitorsCountryComesFromCloudflareOrIsLeftOut(t *testing.T) {
	for header, want := range map[string]string{"EG": "EG", " gb ": "GB", "XX": "", "T1": "", "": "", "USA": "", "1A": "", "E1": ""} {
		r := httptest.NewRequest(http.MethodGet, "/v1/fx", nil)
		if header != "" {
			r.Header.Set("CF-IPCountry", header)
		}
		if got := visitorCountry(r); got != want {
			t.Errorf("%q gave %q, wanted %q", header, got, want)
		}
	}
}

func TestAMainCurrencyIsUsedWhenThereIsARateForIt(t *testing.T) {
	at := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	fx := &fxTable{AsOf: "2026-11-05", Rates: map[string]float64{"USD": 1, "EUR": 0.5, "EGP": 50}}
	b := sample(t) // revenue 200.00 this month in USD, and 10.00 in EUR; MRR 296.00 in USD
	f := financeFrom(b, nil, nil, fx, "EGP", at)
	if f.Currency != "EGP" {
		t.Fatalf("reporting currency %s", f.Currency)
	}
	// 296.00 dollars at 50 is 14,800.00 pounds; this month 200.00 dollars is 10,000.00 and 10.00 euros is 1,000.00 (at 0.5 euros a dollar the euro is worth 2 dollars, 100 pounds).
	if f.MRRMinor != 1_480_000 || f.RevenueThisMonth != 1_100_000 {
		t.Fatalf("mrr %d, this month %d", f.MRRMinor, f.RevenueThisMonth)
	}
	months := map[string]int{}
	for _, m := range f.ByMonth {
		months[m.Month]++
	}
	if months["2026-11"] != 1 {
		t.Fatalf("a month paid in two currencies must be one month: %+v", f.ByMonth)
	}
	// With no rates at all, a main currency that is not the earning one cannot be used: nothing crashes, the earning currency stays.
	if g := financeFrom(b, nil, nil, nil, "EGP", at); g.Currency != "USD" || g.MRRMinor != 29600 {
		t.Fatalf("without rates: %s %d", g.Currency, g.MRRMinor)
	}
	// A main currency with no rate is ignored too.
	if g := financeFrom(b, nil, nil, fx, "ZAR", at); g.Currency != "USD" {
		t.Fatalf("an unknown rate: %s", g.Currency)
	}
}

func TestTheCurrencyTablesAreTheStandardsNotAGuess(t *testing.T) {
	// Currencies that changed in recent years: a hand-typed table is the one that forgets.
	for country, want := range map[string]string{"HR": "EUR", "BG": "EUR", "SL": "SLE", "VE": "VES", "ZW": "ZWG", "EG": "EGP", "US": "USD"} {
		if got := regionCurrency[country]; got != want {
			t.Errorf("%s uses %q, wanted %q", country, got, want)
		}
	}
	for _, retired := range []string{"HRK", "ZWL", "SLL", "VEF"} {
		if isCurrency(retired) {
			t.Errorf("%s is no longer a currency", retired)
		}
	}
	for code, want := range map[string]int{"JPY": 0, "KWD": 3, "USD": 2, "EGP": 2, "ISK": 0, "XOF": 0} {
		if digits(code) != want {
			t.Errorf("%s has %d decimals, wanted %d", code, digits(code), want)
		}
	}
	for country, code := range regionCurrency {
		if !isCurrency(code) {
			t.Errorf("%s uses %s, which is not in the list", country, code)
		}
	}
	if len(isoMinorUnits) < 140 || len(regionCurrency) < 200 {
		t.Errorf("the tables look empty: %d currencies, %d countries", len(isoMinorUnits), len(regionCurrency))
	}
}

func TestTheRatesAnswerSaysWhichCurrencyTheVisitorsCountryUses(t *testing.T) {
	calls, fail := 0, false
	source := fakeSource(t, &calls, &fail)
	defer source.Close()
	old := fxSources
	fxSources = []string{source.URL}
	defer func() { fxSources = old }()
	s := &server{}
	req := httptest.NewRequest(http.MethodGet, "/v1/fx", nil)
	req.Header.Set("CF-IPCountry", "EG")
	rec := httptest.NewRecorder()
	if err := s.publicFX(rec, req); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Country  string `json:"country"`
		Currency string `json:"currency"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil || got.Country != "EG" || got.Currency != "EGP" {
		t.Fatalf("%v %+v", err, got)
	}
}
