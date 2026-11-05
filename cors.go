package main

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// parseOrigins reads CORS_ORIGINS: pages that may read the gateway's own replies from a browser, like
// "https://callerwhale.com,https://app.callerwhale.com". Each is a scheme and a host, nothing more. Empty means none.
func parseOrigins(text string) (map[string]bool, error) {
	origins := map[string]bool{}
	for _, item := range strings.Split(text, ",") {
		if item = strings.TrimSpace(item); item == "" {
			continue
		}
		u, err := url.Parse(item)
		if err != nil || u.Scheme == "" || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil || item != u.Scheme+"://"+u.Host {
			return nil, fmt.Errorf("CORS_ORIGINS: %q is not an origin like https://callerwhale.com", item)
		}
		origins[item] = true
	}
	return origins, nil
}

// corsWriter adds the CORS headers to a reply the gateway wrote itself. When the service behind already set them, they are left
// alone: two Access-Control-Allow-Origin headers make a browser refuse the reply.
type corsWriter struct {
	http.ResponseWriter
	origin string
	done   bool
}

func (c *corsWriter) allow() {
	if c.done {
		return
	}
	c.done = true
	h := c.Header()
	if h.Get("Access-Control-Allow-Origin") == "" {
		h.Set("Access-Control-Allow-Origin", c.origin)
		h.Add("Vary", "Origin")
	}
}

func (c *corsWriter) WriteHeader(status int) {
	c.allow()
	c.ResponseWriter.WriteHeader(status)
}

func (c *corsWriter) Write(b []byte) (int, error) {
	c.allow()
	return c.ResponseWriter.Write(b)
}

func (c *corsWriter) Flush() {
	c.allow()
	_ = http.NewResponseController(c.ResponseWriter).Flush()
}

// Unwrap lets the proxy reach the real connection for WebSockets (http.ResponseController looks through it).
func (c *corsWriter) Unwrap() http.ResponseWriter { return c.ResponseWriter }
