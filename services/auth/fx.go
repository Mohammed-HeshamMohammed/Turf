package main

// Exchange rates, so an amount in one currency can be shown or counted in another: the owner's costs in euros against revenue in
// dollars, and the pricing page in the visitor's own currency. Rates come from a free daily source that needs no key, are kept for six
// hours, and the last good ones are served if the source is down. They are for showing and for the owner's own sums: the amount a
// customer is charged, and the tax on it, are worked out by the payment provider at checkout.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"
)

// fxSources are tried in order. Both publish the same file; the second is a different host in case the first is down.
var fxSources = []string{
	"https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
	"https://latest.currency-api.pages.dev/v1/currencies/usd.json",
}

const (
	fxFresh   = 6 * time.Hour
	fxMinimum = 100 // a source that sends fewer currencies than this is not trusted
)

// isCurrency is true for a current ISO 4217 currency (the table is generated, see currency_data.go). The rates source also lists coins
// and tokens, which are left out.
func isCurrency(code string) bool {
	_, ok := currentTables().digits[code]
	return ok
}

// fxTable is the rates against the US dollar: one dollar buys Rates["EUR"] euros.
type fxTable struct {
	Base  string             `json:"base"`
	AsOf  string             `json:"as_of"`
	Rates map[string]float64 `json:"rates"`
	// fetched is when this server got them (not sent to anyone).
	fetched time.Time
}

type fxCache struct {
	mu    sync.Mutex
	table *fxTable
}

// fetchFX reads one source. Only real currencies with a sensible rate are kept.
func fetchFX(ctx context.Context, url string) (*fxTable, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := (&http.Client{Timeout: 6 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, errors.New("exchange rates: the source answered " + res.Status)
	}
	var raw struct {
		Date string             `json:"date"`
		USD  map[string]float64 `json:"usd"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&raw); err != nil {
		return nil, err
	}
	t := &fxTable{Base: "USD", AsOf: raw.Date, Rates: map[string]float64{"USD": 1}, fetched: time.Now()}
	for code, rate := range raw.USD {
		code = strings.ToUpper(code)
		// The dollar is the base: it is always exactly 1, whatever the source lists for it.
		if code != "USD" && isCurrency(code) && rate > 0 && !math.IsInf(rate, 0) && !math.IsNaN(rate) {
			t.Rates[code] = rate
		}
	}
	if len(t.Rates) < fxMinimum {
		return nil, errors.New("exchange rates: the source sent too few currencies")
	}
	return t, nil
}

// rates returns the table, fetching when it is older than six hours. If every source fails, the last good table is served (and
// nil only when there never was one), so a source being down never takes a screen with it.
func (c *fxCache) rates(ctx context.Context) *fxTable {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.table != nil && time.Since(c.table.fetched) < fxFresh {
		return c.table
	}
	for _, source := range fxSources {
		if table, err := fetchFX(ctx, source); err == nil {
			c.table = table
			return table
		}
	}
	return c.table
}

// digits is the number of decimals the currency's minor unit has: 100 cents to the dollar, none for the yen, a thousand fils to the dinar.
// It comes from ISO 4217; a code the standard does not list is treated as two.
func digits(currency string) int {
	if d, ok := currentTables().digits[currency]; ok {
		return d
	}
	return 2
}

// convert turns an amount in one currency's minor unit into another's, rounded to the nearest. It is false when either currency
// has no rate.
func (t *fxTable) convert(minor int64, from, to string) (int64, bool) {
	if from == to {
		return minor, true
	}
	if t == nil {
		return 0, false
	}
	a, b := t.Rates[from], t.Rates[to]
	if a <= 0 || b <= 0 {
		return 0, false
	}
	major := float64(minor) / math.Pow10(digits(from))
	return int64(math.Round(major / a * b * math.Pow10(digits(to)))), true
}

// factor is how many units of `to` one unit of `from` is worth (for a price per minute, which is a fraction of a unit).
func (t *fxTable) factor(from, to string) (float64, bool) {
	if from == to {
		return 1, true
	}
	if t == nil || t.Rates[from] <= 0 || t.Rates[to] <= 0 {
		return 0, false
	}
	return t.Rates[to] / t.Rates[from], true
}

// publicFX is what anyone may read: the rates and their date. The pricing page uses it to show prices in the visitor's currency.
func (s *server) publicFX(w http.ResponseWriter, r *http.Request) error {
	table := s.fx.rates(r.Context())
	if table == nil {
		return newError(http.StatusServiceUnavailable, "rates_unavailable", "Exchange rates are not available right now.")
	}
	// The answer also says where the visitor is (Cloudflare tells us, from their address), so a browser may keep it but a shared cache may
	// not hand one visitor's country to another. writeJSON would mark it uncacheable altogether.
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	// The currency tables are kept live: this starts a refresh when they are a day old (in the background, so nobody waits for it).
	startCurrencyRefresh()
	tables := currentTables()
	country := visitorCountry(r)
	_ = json.NewEncoder(w).Encode(struct {
		*fxTable
		Country  string            `json:"country,omitempty"`
		Currency string            `json:"currency,omitempty"` // the currency of that country
		Digits   map[string]int    `json:"digits"`             // every current currency and its decimals
		Regions  map[string]string `json:"regions"`            // the currency each country uses now
		Source   string            `json:"currency_source"`
	}{table, country, tables.regions[country], tables.digits, tables.regions, tables.source})
	return nil
}

// visitorCountry is the two-letter country Cloudflare saw the request come from, or "" when it did not say (a direct request, an
// unknown address, Tor). It only chooses a default currency; nothing depends on it being right.
func visitorCountry(r *http.Request) string {
	code := strings.ToUpper(strings.TrimSpace(r.Header.Get("CF-IPCountry")))
	if len(code) != 2 || code == "XX" || code == "T1" {
		return ""
	}
	for _, c := range code {
		if c < 'A' || c > 'Z' {
			return ""
		}
	}
	return code
}

// setCurrency saves a person's main currency, or clears it (empty) to go back to automatic.
func (s *server) setCurrency(w http.ResponseWriter, r *http.Request) error {
	c, err := s.person(r)
	if err != nil {
		return err
	}
	var body struct {
		Currency string `json:"currency"`
	}
	if err := readJSON(w, r, &body); err != nil {
		return err
	}
	body.Currency = strings.ToUpper(strings.TrimSpace(body.Currency))
	if body.Currency != "" && !isCurrency(body.Currency) {
		return bad("That is not a currency we know. Choose one from the list.")
	}
	if _, err := s.db.Exec(r.Context(), "UPDATE users SET currency = $1 WHERE id = $2", body.Currency, c.Sub); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"currency": body.Currency})
	return nil
}
