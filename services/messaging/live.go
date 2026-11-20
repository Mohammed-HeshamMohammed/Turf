package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// Live delivery goes through Centrifugo, a ready-made real-time server: it holds the sockets, this service tells it what to send.
// Each person listens on one channel of their own ("chat:user#<their id>"; Centrifugo lets only that person subscribe to it), whatever
// workspace or conversation the update is about. The update is only a prompt: the database is the truth, and an app that missed
// one asks for the messages after the last number it has.

const (
	channelPrefix = "chat:user#"
	liveTokenTTL  = 10 * time.Minute
)

type live struct {
	api, key, secret, public string
	http                     *http.Client
}

func newLive(c config) *live {
	return &live{api: c.liveAPI, key: c.liveAPIKey, secret: c.liveSecret, public: c.livePublic, http: &http.Client{Timeout: 5 * time.Second}}
}

func (l *live) enabled() bool { return l.api != "" }

// token is a Centrifugo connection token (HS256): it says who is connecting and for how long. The app asks for a new one when it
// runs out, with its sign-in token, so a signed-out person stops receiving within minutes.
func (l *live) token(user string, now time.Time) string {
	enc := func(v any) string { b, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(b) }
	head := enc(map[string]string{"alg": "HS256", "typ": "JWT"})
	body := enc(map[string]any{"sub": user, "iat": now.Unix(), "exp": now.Add(liveTokenTTL).Unix()})
	mac := hmac.New(sha256.New, []byte(l.secret))
	mac.Write([]byte(head + "." + body))
	return head + "." + body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// liveToken tells the app where to listen and gives it a short-lived token to do so.
func (s *server) liveToken(q *req) error {
	if !s.live.enabled() {
		writeJSON(q.w, 200, map[string]any{"enabled": false})
		return nil
	}
	user := lowerID(q.c.Sub)
	writeJSON(q.w, 200, map[string]any{"enabled": true, "url": s.live.public, "token": s.live.token(user, s.now()), "channel": channelPrefix + user, "expires_in": int(liveTokenTTL.Seconds())})
	return nil
}

func lowerID(id string) string { return string(bytes.ToLower([]byte(id))) }

// send hands one queued update to Centrifugo. The outbox row's number goes along as the idempotency key, so an update sent
// twice (the reply was lost, the row was not yet deleted) is delivered once.
func (l *live) send(ctx context.Context, id int64, method string, payload []byte) error {
	if !l.enabled() {
		return nil
	}
	var body map[string]any
	if err := json.Unmarshal(payload, &body); err != nil {
		return nil // a row that is not JSON can never be sent: drop it
	}
	if channels, _ := body["channels"].([]any); method == "broadcast" && len(channels) == 0 {
		return nil
	}
	body["idempotency_key"] = "outbox-" + strconv.FormatInt(id, 10)
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, l.api+"/"+method, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", l.key)
	res, err := l.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	answer, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("live server answered %d", res.StatusCode)
	}
	// Centrifugo answers 200 with an "error" object when it refuses a command.
	var reply struct {
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(answer, &reply) == nil && reply.Error != nil {
		return fmt.Errorf("live server refused: %d %s", reply.Error.Code, reply.Error.Message)
	}
	return nil
}

// flush sends what is waiting, oldest first, and deletes what was delivered. It stops at the first failure so updates never
// overtake each other. Rows are locked while they are sent, so two copies of the service do not send the same one.
func (s *server) flush(ctx context.Context) (sent int, err error) {
	tx, err := s.st.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT id, method, payload FROM outbox ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`)
	if err != nil {
		return 0, err
	}
	type row struct {
		id      int64
		method  string
		payload []byte
	}
	var batch []row
	for rows.Next() {
		var r row
		if err = rows.Scan(&r.id, &r.method, &r.payload); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, r)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return 0, err
	}
	var done []int64
	var failure error
	for _, r := range batch {
		if failure = s.live.send(ctx, r.id, r.method, r.payload); failure != nil {
			break
		}
		done = append(done, r.id)
	}
	if len(done) > 0 {
		if _, err = tx.Exec(ctx, `DELETE FROM outbox WHERE id = ANY($1)`, done); err != nil {
			return 0, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(done), failure
}

// deliver runs for the life of the service: it sends the outbox whenever a change says there is something new, and every two
// seconds regardless, so nothing waits on a missed signal.
func (s *server) deliver(ctx context.Context) {
	wake := make(chan struct{}, 1)
	go s.listen(ctx, wake)
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	// What the Runtime Logs show about delivery: one line when it breaks (with the count so far), one when it recovers, and a
	// one-minute total while updates flow. A healthy idle service prints nothing.
	var failing, sentSince int
	lastReport := time.Now()
	for {
		for {
			n, err := s.flush(ctx)
			sentSince += n
			if err != nil && ctx.Err() == nil {
				failing++
				if failing == 1 || failing%30 == 0 {
					log.Printf("WARN live delivery: %v (failed %d times in a row; updates wait in the database and nothing is lost)", err, failing)
				}
			} else if err == nil && failing > 0 {
				log.Printf("INFO live delivery recovered after %d failed tries", failing)
				failing = 0
			}
			if err != nil || n < 100 {
				break
			}
		}
		if time.Since(lastReport) >= time.Minute {
			if sentSince > 0 {
				log.Printf("INFO live delivery: %d updates sent in the last minute", sentSince)
			}
			sentSince, lastReport = 0, time.Now()
		}
		select {
		case <-ctx.Done():
			return
		case <-wake:
		case <-tick.C:
		}
	}
}

// listen follows the database's "something was queued" signal until ctx ends, reconnecting when the link drops.
func (s *server) listen(ctx context.Context, wake chan<- struct{}) {
	for ctx.Err() == nil {
		err := func() error {
			conn, err := pgx.Connect(ctx, s.cfg.databaseURL)
			if err != nil {
				return err
			}
			defer conn.Close(context.Background())
			if _, err = conn.Exec(ctx, `LISTEN messaging_outbox`); err != nil {
				return err
			}
			for {
				if _, err = conn.WaitForNotification(ctx); err != nil {
					return err
				}
				select {
				case wake <- struct{}{}:
				default: // a flush is already due
				}
			}
		}()
		if err != nil && ctx.Err() == nil {
			log.Printf("WARN the outbox signal dropped: %v", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
}
