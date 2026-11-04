package main

// The website's contact form. A visitor's browser posts the message here (through the gateway, which checks the visitor is a
// person and limits each address); this service checks it again, limits it again, and emails it to the team's inbox with the
// existing "contact" template. Nothing is stored: the email is the record.

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"net/mail"
	"strings"
	"time"
)

const (
	contactPath = "/api/v1/public/contact"
	// One address may send this many messages an hour: a person writes once or twice; a script writes a lot.
	contactPerHour = 5
)

// contactRequest is what the form sends. website is a field no person sees: when it has anything in it, a script filled it.
type contactRequest struct {
	Name    string `json:"name"`
	Email   string `json:"email"`
	Message string `json:"message"`
	Website string `json:"website"`
}

// withContact turns the form on: messages go to `to`, and pages on the listed origins may post to it from a browser.
func (s *Server) withContact(to string, origins []string) *Server {
	s.contactTo = strings.TrimSpace(to)
	s.contactOrigins = map[string]bool{}
	for _, origin := range origins {
		if origin = strings.TrimSpace(origin); origin != "" {
			s.contactOrigins[origin] = true
		}
	}
	return s
}

// cors answers the browser's permission check for a page on an allowed origin. Any other origin gets no permission headers.
func (s *Server) cors(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin != "" && s.contactOrigins[origin] {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Methods", "POST")
		w.Header().Set("Access-Control-Allow-Headers", "content-type")
		w.Header().Set("Access-Control-Max-Age", "600")
	}
}

func (s *Server) contactPreflight(w http.ResponseWriter, r *http.Request) {
	s.cors(w, r)
	w.WriteHeader(http.StatusNoContent)
}

// visitor is the address the request came from: the gateway puts the real one in X-Forwarded-For (it removes anything the
// visitor sent), and a request that did not come through it is counted by its own connection.
func visitor(r *http.Request) string {
	if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0]); net.ParseIP(forwarded) != nil {
		return forwarded
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// allowContact counts a message against the sender's address for the last hour.
func (s *Server) allowContact(who string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	key := "contact:" + who
	kept := s.window[key][:0]
	for _, t := range s.window[key] {
		if now.Sub(t) < time.Hour {
			kept = append(kept, t)
		}
	}
	if len(kept) >= contactPerHour {
		s.window[key] = kept
		return false
	}
	s.window[key] = append(kept, now)
	return true
}

func (s *Server) contact(w http.ResponseWriter, r *http.Request) {
	s.cors(w, r)
	if s.contactTo == "" || !s.configured || s.sender == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "The contact form is not available right now. Try again later."})
		return
	}
	var req contactRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "That message could not be read."})
		return
	}
	// A filled trap field is a script. It is told the message went, so it learns nothing, and nothing is sent.
	if strings.TrimSpace(req.Website) != "" {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
		return
	}
	address, err := mail.ParseAddress(strings.TrimSpace(req.Email))
	if err != nil || address.Name != "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Enter a valid email address so we can reply."})
		return
	}
	message, name := strings.TrimSpace(req.Message), strings.TrimSpace(req.Name)
	if message == "" || len(message) > 4000 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Write your message (up to 4,000 characters)."})
		return
	}
	if len(name) > 120 || strings.ContainsAny(name, "\r\n") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Keep your name short, on one line."})
		return
	}
	who := visitor(r)
	if !s.allowContact(who) {
		w.Header().Set("Retry-After", "3600")
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "You have sent several messages already. Try again in an hour."})
		return
	}
	msg, err := Render("contact", s.contactTo, map[string]any{"name": name, "email": address.Address, "message": message})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "That message could not be sent."})
		return
	}
	if err := s.sender.Send(msg); err != nil {
		log.Printf("contact form message not sent: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "We could not send your message. Try again in a moment."})
		return
	}
	log.Print("contact form message sent")
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
}
