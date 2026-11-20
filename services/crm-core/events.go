package main

// /events: a WebSocket that tells a device something changed, so it pulls at once instead of waiting. It carries no records,
// only the kind of change, so what a person may see is still decided by the pull. Changes reach it through PostgreSQL's
// LISTEN/NOTIFY, so every copy of crm-core hears every commit, whichever copy made it.

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
)

type subscriber struct {
	org string
	ch  chan []byte
}

type hub struct {
	mu   sync.Mutex
	subs map[*subscriber]struct{}
}

func newHub() *hub { return &hub{subs: map[*subscriber]struct{}{}} }

func (h *hub) add(org string) *subscriber {
	sub := &subscriber{org: org, ch: make(chan []byte, 32)}
	h.mu.Lock()
	h.subs[sub] = struct{}{}
	h.mu.Unlock()
	return sub
}

func (h *hub) remove(sub *subscriber) {
	h.mu.Lock()
	delete(h.subs, sub)
	h.mu.Unlock()
}

// publish hands a message to everyone in a workspace ("" is everyone). A device that cannot keep up misses messages, and
// is told to start over, which is a pull.
func (h *hub) publish(org string, message []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.subs {
		if org != "" && sub.org != org {
			continue
		}
		select {
		case sub.ch <- message:
		default:
		}
	}
}

// listen follows the database's change notifications until ctx ends, reconnecting when the link drops.
func (h *hub) listen(ctx context.Context, url string) {
	for ctx.Err() == nil {
		if err := h.follow(ctx, url); err != nil && ctx.Err() == nil {
			log.Printf("WARN the change feed dropped: %v", err)
		}
		// Anything committed while the link was down is picked up by a pull.
		h.publish("", []byte(`{"kind":"resync"}`))
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
}

func (h *hub) follow(ctx context.Context, url string) error {
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if _, err = conn.Exec(ctx, `LISTEN cw_events`); err != nil {
		return err
	}
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		var event struct {
			OrgID  string `json:"org_id"`
			Kind   string `json:"kind"`
			Entity string `json:"entity"`
			Seq    int64  `json:"seq"`
		}
		if json.Unmarshal([]byte(n.Payload), &event) != nil {
			continue
		}
		out, _ := json.Marshal(map[string]any{"kind": event.Kind, "entity": event.Entity, "seq": event.Seq})
		h.publish(event.OrgID, out)
	}
}

// A browser cannot put headers on a WebSocket, so the token and workspace travel in its subprotocol list
// ("callerwhale.v1", "bearer.<token>", "org.<id>"), which the server reads and, unlike the address, does not log.
func protocols(r *http.Request) (token, org string) {
	for _, header := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, p := range strings.Split(header, ",") {
			p = strings.TrimSpace(p)
			if v, ok := strings.CutPrefix(p, "bearer."); ok {
				token = v
			} else if v, ok := strings.CutPrefix(p, "org."); ok {
				org = v
			}
		}
	}
	return
}

const socketLife = 10 * time.Minute // then the device reconnects with a fresh token, and access is checked again

func (s *server) events(w http.ResponseWriter, r *http.Request) {
	token, org := protocols(r)
	q, err := s.identifyToken(w, r, token)
	if err == nil {
		err = s.enter(r.Context(), q, org)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	// The pages that connect are on other addresses than this one; the token in the handshake is the proof, not a cookie.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"callerwhale.v1"}, InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	sub := s.hub.add(q.sc.orgID)
	defer s.hub.remove(sub)
	ctx, cancel := context.WithTimeout(conn.CloseRead(r.Context()), socketLife)
	defer cancel()
	write := func(message []byte) bool {
		wctx, done := context.WithTimeout(ctx, 10*time.Second)
		defer done()
		return conn.Write(wctx, websocket.MessageText, message) == nil
	}
	if !write([]byte(`{"kind":"hello"}`)) {
		return
	}
	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			conn.Close(websocket.StatusNormalClosure, "reconnect")
			return
		case message := <-sub.ch:
			if !write(message) {
				return
			}
		case <-ping.C:
			pctx, done := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Ping(pctx)
			done()
			if err != nil {
				return
			}
		}
	}
}
