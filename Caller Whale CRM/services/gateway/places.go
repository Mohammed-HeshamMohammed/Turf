package main

// Build step 35, D243: an agency's owner can limit its members to chosen countries and office networks. The gateway is the one place
// that sees every request's real address and country (Cloudflare's CF-IPCountry) with the agency it is made in (x-callerwhale-org), so
// it checks them here. The rules come from authz (AUTHZ_URL, AUTHZ_TOKEN: the gateway's token, which may read only these), kept for a
// minute. The owner is never limited, so the agency can always be reached to change them. When authz cannot be asked, requests go on
// and the services' own checks still apply.

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

type placeRules struct {
	Countries []string `json:"countries"`
	Networks  []string `json:"networks"`
	Exempt    []string `json:"exempt"`
	nets      []*net.IPNet
	at        time.Time
}

type placeCache struct {
	mu     sync.Mutex
	byOrg  map[string]*placeRules
	client *http.Client
}

var orgID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// placeRulesFor is the agency's rules, at most a minute old; nil when there are none or they cannot be read.
func (g *gateway) placeRulesFor(org string) *placeRules {
	g.places.mu.Lock()
	cached := g.places.byOrg[org]
	g.places.mu.Unlock()
	if cached != nil && g.now().Sub(cached.at) < time.Minute {
		return cached
	}
	req, err := http.NewRequest(http.MethodGet, g.cfg.authzURL+"/v1/orgs/"+org+"/access-limits", nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+g.cfg.authzToken)
	res, err := g.places.client.Do(req)
	if err != nil {
		log.Printf("WARN access limits of %s: %v", org, err)
		return cached
	}
	defer res.Body.Close()
	var rules placeRules
	if res.StatusCode != http.StatusOK || json.NewDecoder(res.Body).Decode(&rules) != nil {
		return cached
	}
	for _, n := range rules.Networks {
		if _, cidr, err := net.ParseCIDR(n); err == nil {
			rules.nets = append(rules.nets, cidr)
		}
	}
	rules.at = g.now()
	g.places.mu.Lock()
	if len(g.places.byOrg) > 10000 {
		g.places.byOrg = map[string]*placeRules{}
	}
	g.places.byOrg[org] = &rules
	g.places.mu.Unlock()
	return &rules
}

// placeAllowed answers whether a request inside an agency comes from a country and network the agency allows. Requests outside an
// agency, without a valid sign-in, or for an agency with no rules always go on.
func (g *gateway) placeAllowed(r *http.Request, caller string) (bool, string) {
	org := strings.TrimSpace(r.Header.Get("x-callerwhale-org"))
	if g.cfg.authzURL == "" || !orgID.MatchString(org) {
		return true, ""
	}
	c, err := g.identify(r)
	if err != nil {
		return true, ""
	}
	rules := g.placeRulesFor(strings.ToLower(org))
	if rules == nil || (len(rules.Countries) == 0 && len(rules.nets) == 0) || slices.Contains(rules.Exempt, c.sub) {
		return true, ""
	}
	if len(rules.Countries) > 0 && !slices.Contains(rules.Countries, strings.ToUpper(strings.TrimSpace(r.Header.Get("CF-IPCountry")))) {
		return false, "Your agency allows its people to work only from chosen countries. Ask its owner if you need to work from here."
	}
	if len(rules.nets) > 0 {
		ip := net.ParseIP(caller)
		if ip == nil || !slices.ContainsFunc(rules.nets, func(n *net.IPNet) bool { return n.Contains(ip) }) {
			return false, "Your agency allows its people to work only from its office networks. Ask its owner if you need to work from here."
		}
	}
	return true, ""
}
