package main

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// parseOrigins reads CORS_ORIGINS: the pages that may call this service from a browser, like "https://app.callerwhale.com". Each is a
// scheme and a host, nothing more. The gateway passes a browser's preflight on to this service and leaves the answer to it.
func parseOrigins(text string) (map[string]bool, error) {
	origins := map[string]bool{}
	for _, item := range strings.Split(text, ",") {
		if item = strings.TrimSpace(item); item == "" {
			continue
		}
		u, err := url.Parse(item)
		if err != nil || u.Scheme == "" || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil || item != u.Scheme+"://"+u.Host {
			return nil, fmt.Errorf("CORS_ORIGINS: %q is not an origin like https://app.callerwhale.com", item)
		}
		origins[item] = true
	}
	return origins, nil
}

// withCORS lets pages on the listed origins read this service's replies. The contact form is answered by the notification service, which has
// its own list, so its paths are left alone (two sets of headers make a browser refuse the reply).
func withCORS(origins map[string]bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && origins[origin] && (!strings.HasPrefix(r.URL.Path, "/api/v1/public/") || r.URL.Path == "/api/v1/public/remove-my-information") {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			if r.Method == http.MethodOptions {
				h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
				h.Set("Access-Control-Allow-Headers", "authorization, content-type, x-callerwhale-org, x-chunk-sha256")
				h.Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
