package main

// The currency tables kept live. currency_data.go is a snapshot of the standards (ISO 4217 and Unicode CLDR) generated at build time;
// it is what the server knows when it starts and whatever happens next. While it runs, the server fetches the standards again once a
// day, and from then on uses what they say now: a country that changes currency, or a currency that is retired, is picked up without a
// release. If a fetch fails, or what it returns does not look right, the last good tables stay. The rules below are the same as
// tools/currency-data.mjs, which writes the snapshot.

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sync"
	"sync/atomic"
	"time"
)

// currencySources are where the standards are fetched from (variables so tests can point them at a fake).
var currencySources = struct{ iso, cldr string }{
	iso:  "https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml",
	cldr: "https://cdn.jsdelivr.net/npm/cldr-core@latest/supplemental/currencyData.json",
}

const (
	currencyFresh = 24 * time.Hour
	currencyRetry = 15 * time.Minute // after a failed fetch, wait before trying again
)

// notMoney are ISO codes a person is not charged in: precious metals, special drawing rights, test and "no currency" codes, funds codes.
var notMoney = map[string]bool{
	"XAU": true, "XAG": true, "XPT": true, "XPD": true, "XDR": true, "XTS": true, "XXX": true, "XBA": true, "XBB": true, "XBC": true, "XBD": true,
	"XSU": true, "XUA": true, "USN": true, "CHE": true, "CHW": true, "CLF": true, "COU": true, "BOV": true, "MXV": true, "UYI": true, "UYW": true,
}

type currencyTables struct {
	digits  map[string]int    // currency -> decimals in its minor unit
	regions map[string]string // two-letter country -> the currency used there now
	source  string
	fetched time.Time
}

// liveCurrency is what the standards said at the last good fetch; nil until there is one (the snapshot is used meanwhile).
var liveCurrency atomic.Pointer[currencyTables]

var (
	refreshing  sync.Mutex
	nextAttempt atomic.Int64 // Unix seconds before which no new fetch is started
)

// currentTables is the live tables when there are any, and the snapshot otherwise.
func currentTables() currencyTables {
	if live := liveCurrency.Load(); live != nil {
		return *live
	}
	return currencyTables{digits: isoMinorUnits, regions: regionCurrency, source: currencySource}
}

// startCurrencyRefresh begins a refresh in the background (a variable so tests do not reach the internet).
var startCurrencyRefresh = func() { go refreshCurrencyTables(context.Background()) }

// refreshCurrencyTables fetches the standards when the tables are older than a day. At most one fetch runs at a time and a failure
// is not retried at once, so a slow or broken source costs nothing. It is meant to be run in the background.
func refreshCurrencyTables(ctx context.Context) {
	if live := liveCurrency.Load(); live != nil && time.Since(live.fetched) < currencyFresh {
		return
	}
	if time.Now().Unix() < nextAttempt.Load() || !refreshing.TryLock() {
		return
	}
	defer refreshing.Unlock()
	tables, err := fetchCurrencyTables(ctx)
	if err != nil {
		nextAttempt.Store(time.Now().Add(currencyRetry).Unix())
		return
	}
	liveCurrency.Store(tables)
}

func fetchCurrencyTables(ctx context.Context) (*currencyTables, error) {
	isoRaw, err := fetchBytes(ctx, currencySources.iso, 4<<20)
	if err != nil {
		return nil, err
	}
	cldrRaw, err := fetchBytes(ctx, currencySources.cldr, 8<<20)
	if err != nil {
		return nil, err
	}
	digits, published, err := parseISO(isoRaw)
	if err != nil {
		return nil, err
	}
	regions, version, err := parseCLDR(cldrRaw, digits, time.Now().UTC().Format("2006-01-02"))
	if err != nil {
		return nil, err
	}
	return &currencyTables{digits: digits, regions: regions, source: fmt.Sprintf("ISO 4217 as published %s by SIX; CLDR %s", published, version), fetched: time.Now()}, nil
}

func fetchBytes(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, errors.New("currency data: " + url + " answered " + res.Status)
	}
	return io.ReadAll(io.LimitReader(res.Body, limit))
}

var singleDigit = regexp.MustCompile(`^\d$`)

// parseISO reads SIX's ISO 4217 list: each currency's code and its minor-unit digits ("N.A." entries have none and are left out).
func parseISO(raw []byte) (map[string]int, string, error) {
	var list struct {
		Published string `xml:"Pblshd,attr"`
		Entries   []struct {
			Code  string `xml:"Ccy"`
			Minor string `xml:"CcyMnrUnts"`
		} `xml:"CcyTbl>CcyNtry"`
	}
	if err := xml.Unmarshal(raw, &list); err != nil {
		return nil, "", err
	}
	digits := map[string]int{}
	for _, e := range list.Entries {
		if len(e.Code) != 3 || notMoney[e.Code] || !singleDigit.MatchString(e.Minor) {
			continue
		}
		digits[e.Code] = int(e.Minor[0] - '0')
	}
	if len(digits) < 140 {
		return nil, "", fmt.Errorf("currency data: ISO 4217 gave only %d currencies", len(digits))
	}
	return digits, list.Published, nil
}

// parseCLDR reads CLDR's currency data: for each country, the currency in use today (not ended, started, legal tender). When two are in
// use (Zimbabwe has its own and the dollar) the newest is the one prices are set in.
func parseCLDR(raw []byte, digits map[string]int, today string) (map[string]string, string, error) {
	var doc struct {
		Supplemental struct {
			Version struct {
				CLDR string `json:"_cldrVersion"`
			} `json:"version"`
			CurrencyData struct {
				Region map[string][]map[string]struct {
					From   string `json:"_from"`
					To     string `json:"_to"`
					Tender string `json:"_tender"`
				} `json:"region"`
			} `json:"currencyData"`
		} `json:"supplemental"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, "", err
	}
	regions := map[string]string{}
	for region, list := range doc.Supplemental.CurrencyData.Region {
		if len(region) != 2 || region[0] < 'A' || region[0] > 'Z' || region[1] < 'A' || region[1] > 'Z' {
			continue // 001 (the world), 419 (Latin America)...
		}
		best, bestFrom := "", ""
		for _, item := range list {
			for code, info := range item {
				if _, known := digits[code]; !known || info.Tender == "false" || info.To != "" {
					continue
				}
				from := info.From
				if from == "" {
					from = "0000"
				}
				if from > today {
					continue
				}
				if best == "" || from > bestFrom {
					best, bestFrom = code, from
				}
			}
		}
		if best != "" {
			regions[region] = best
		}
	}
	if len(regions) < 200 {
		return nil, "", fmt.Errorf("currency data: CLDR gave only %d countries", len(regions))
	}
	return regions, doc.Supplemental.Version.CLDR, nil
}
