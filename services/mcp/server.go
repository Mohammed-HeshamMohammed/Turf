package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	protocolVersion = "2025-06-18"
	callsPerMinute  = 60
	cacheSeconds    = 20
)

// supportedVersions are the protocol versions this server answers to; an unknown one is answered with the newest.
var supportedVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

type server struct {
	cfg    config
	client *http.Client
	mu     sync.Mutex
	cache  map[string]cached  // access token hash → what auth said, for a few seconds
	rate   map[string]*window // grant → calls in the current minute
	now    func() time.Time
}

type cached struct {
	who     *who
	expires time.Time
}

type window struct {
	start time.Time
	count int
}

// who is what auth says about an access token.
type who struct {
	Active       bool        `json:"active"`
	GrantID      string      `json:"grant_id"`
	Sub          string      `json:"sub"`
	Name         string      `json:"name"`
	Email        string      `json:"email"`
	Scope        string      `json:"scope"`
	ClientName   string      `json:"client_name"`
	PlatformRole string      `json:"platform_role"`
	Workspaces   []workspace `json:"workspaces"`
}

type workspace struct {
	OrgID         string   `json:"org_id"`
	Roles         []string `json:"roles"`
	BusinessOwner bool     `json:"business_owner"`
}

func (w *who) allows(scope string) bool {
	for _, have := range strings.Fields(w.Scope) {
		if have == scope {
			return true
		}
	}
	return false
}

func newServer(cfg config, client *http.Client) *server {
	return &server{cfg: cfg, client: client, cache: map[string]cached{}, rate: map[string]*window{}, now: time.Now}
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, map[string]any{"ok": true}) })
	// How an assistant finds out where to sign the person in (RFC 9728), for the root and for the /mcp path.
	mux.HandleFunc("GET /.well-known/oauth-protected-resource", s.resourceMetadata)
	mux.HandleFunc("GET /.well-known/oauth-protected-resource/mcp", s.resourceMetadata)
	mux.HandleFunc("POST /mcp", s.mcp)
	mux.HandleFunc("GET /mcp", func(w http.ResponseWriter, r *http.Request) { // no server-sent stream: only POST
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "Use POST."})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "Not found."})
	})
	return s.access(secure(s.cors(mux)))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// secure keeps anything this service says from being cached, sniffed or framed: every answer is data for one caller.
func secure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

// cors lets a browser-based assistant call this service. Nothing here uses cookies: the bearer token is the only credential.
func (s *server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id")
		h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		h.Set("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (s *server) access(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		started := s.now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		if sw.status == 0 {
			sw.status = http.StatusOK
		}
		line, _ := json.Marshal(map[string]any{"cw_event": "request", "method": r.Method, "path": r.URL.Path, "status": sw.status, "duration_seconds": s.now().Sub(started).Seconds()})
		fmt.Println(string(line))
	})
}

func (s *server) resourceMetadata(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"resource": s.cfg.publicURL, "authorization_servers": []string{s.cfg.authPublic},
		"scopes_supported": []string{"account:read"}, "bearer_methods_supported": []string{"header"},
		"resource_name": "Caller Whale",
	})
}

// unauthorized answers 401 with the pointer an assistant follows to start the sign-in.
func (s *server) unauthorized(w http.ResponseWriter, message string) {
	w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="`+s.cfg.publicURL+`/.well-known/oauth-protected-resource"`)
	writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized", "error_description": message})
}

// introspect asks auth who an access token belongs to, remembering the answer for a few seconds so a burst of calls is one question.
// A token auth does not know (ended, expired, wrong) is nil.
func (s *server) introspect(token string) (*who, error) {
	sum := sha256.Sum256([]byte(token))
	key := hex.EncodeToString(sum[:])
	s.mu.Lock()
	if hit, ok := s.cache[key]; ok && s.now().Before(hit.expires) {
		s.mu.Unlock()
		return hit.who, nil
	}
	s.mu.Unlock()
	var found who
	if err := s.askAuth("/v1/connectors/introspect", map[string]any{"token": token}, &found); err != nil {
		return nil, err
	}
	var result *who
	if found.Active {
		result = &found
	}
	s.mu.Lock()
	s.cache[key] = cached{who: result, expires: s.now().Add(cacheSeconds * time.Second)}
	if len(s.cache) > 2000 { // never grow without a limit
		for k, v := range s.cache {
			if s.now().After(v.expires) {
				delete(s.cache, k)
			}
		}
	}
	s.mu.Unlock()
	return result, nil
}

// askAuth is a call to the auth service's private questions, with the shared secret.
func (s *server) askAuth(path string, body map[string]any, into any) error {
	payload, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, s.cfg.authURL+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.authToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		return &authError{status: res.StatusCode, body: string(data)}
	}
	return json.Unmarshal(data, into)
}

type authError struct {
	status int
	body   string
}

func (e *authError) Error() string { return "auth answered " + http.StatusText(e.status) }

// allowCall is a limit per connection: callsPerMinute in any minute. The runaway case is an assistant in a loop.
func (s *server) allowCall(grant string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	win := s.rate[grant]
	if win == nil || s.now().Sub(win.start) >= time.Minute {
		win = &window{start: s.now()}
		s.rate[grant] = win
	}
	win.count++
	return win.count <= callsPerMinute
}

// ---- the protocol ----

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

func rpcResult(id json.RawMessage, result any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
}

func rpcError(id json.RawMessage, code int, message string) map[string]any {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	return map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}}
}

func (s *server) mcp(w http.ResponseWriter, r *http.Request) {
	header := r.Header.Get("Authorization")
	if len(header) < 8 || !strings.EqualFold(header[:7], "bearer ") {
		s.unauthorized(w, "Sign in to Caller Whale to use this connector.")
		return
	}
	person, err := s.introspect(strings.TrimSpace(header[7:]))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "Caller Whale could not check your sign-in right now. Try again."})
		return
	}
	if person == nil {
		s.unauthorized(w, "This connection was ended or has expired. Connect again.")
		return
	}
	var req rpcRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil || req.JSONRPC != "2.0" {
		writeJSON(w, http.StatusBadRequest, rpcError(nil, -32700, "The request is not valid JSON-RPC."))
		return
	}
	if len(req.ID) == 0 { // a notification: nothing to answer
		w.WriteHeader(http.StatusAccepted)
		return
	}
	switch req.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &params)
		version := protocolVersion
		for _, v := range supportedVersions {
			if v == params.ProtocolVersion {
				version = v
			}
		}
		writeJSON(w, http.StatusOK, rpcResult(req.ID, map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "caller-whale", "title": "Caller Whale", "version": "0.1.0"},
			"instructions":    "Caller Whale tools for the person who connected you. Today they cover their account and plan. Ask before doing anything on their behalf.",
		}))
	case "ping":
		writeJSON(w, http.StatusOK, rpcResult(req.ID, map[string]any{}))
	case "tools/list":
		writeJSON(w, http.StatusOK, rpcResult(req.ID, map[string]any{"tools": toolList(person)}))
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil || params.Name == "" {
			writeJSON(w, http.StatusOK, rpcError(req.ID, -32602, "Name the tool to call."))
			return
		}
		if !s.allowCall(person.GrantID) {
			writeJSON(w, http.StatusOK, rpcResult(req.ID, toolText("Too many calls in a minute. Wait a little and try again.", true)))
			return
		}
		started := s.now()
		result := s.callTool(person, strings.TrimSpace(strings.TrimPrefix(header, header[:7])), params.Name, params.Arguments)
		audit, _ := json.Marshal(map[string]any{"cw_event": "mcp_call", "grant": person.GrantID, "tool": params.Name, "error": result["isError"] == true, "duration_seconds": s.now().Sub(started).Seconds()})
		fmt.Println(string(audit))
		writeJSON(w, http.StatusOK, rpcResult(req.ID, result))
	default:
		writeJSON(w, http.StatusOK, rpcError(req.ID, -32601, "That method is not supported."))
	}
}
