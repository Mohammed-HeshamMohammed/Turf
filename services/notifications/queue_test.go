package main

import (
	"context"
	"errors"
	"net/textproto"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// flakySender fails while down (or for good, when permanent is set) and is safe to call side by side.
type flakySender struct {
	mu        sync.Mutex
	sent      []Message
	down      bool
	permanent bool
}

func (f *flakySender) Send(m Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case f.permanent:
		return refusal("the mail server refused the recipient", &textproto.Error{Code: 550, Msg: "no such user"})
	case f.down:
		return refusal("the mail server refused the message", &textproto.Error{Code: 451, Msg: "try again later"})
	}
	f.sent = append(f.sent, m)
	return nil
}

func (f *flakySender) count() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.sent) }

func (f *flakySender) set(down, permanent bool) {
	f.mu.Lock()
	f.down, f.permanent = down, permanent
	f.mu.Unlock()
}

// newQueue gives a queue on an empty notifications schema, or skips without NOTIFY_TEST_DATABASE_URL.
func newQueue(t *testing.T, sender Sender) *queue {
	t.Helper()
	url := os.Getenv("NOTIFY_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set NOTIFY_TEST_DATABASE_URL to run the mail queue tests")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = admin.Exec(ctx, `DROP SCHEMA IF EXISTS notifications CASCADE`); err != nil {
		t.Fatal(err)
	}
	admin.Close()
	q, err := openQueue(ctx, url, sender)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(q.close)
	return q
}

// due makes every waiting email due now, as if its wait had passed.
func due(t *testing.T, q *queue) {
	t.Helper()
	if _, err := q.db.Exec(context.Background(), `UPDATE mail_queue SET next_try_at = now()`); err != nil {
		t.Fatal(err)
	}
}

func TestAnEmailTheMailServerCannotTakeYetIsKeptAndSentOnceLater(t *testing.T) {
	sender := &flakySender{down: true}
	q := newQueue(t, sender)
	s := newServer(map[string][]string{"auth": {testToken}}, sender, true)
	s.queue = q
	ctx := context.Background()

	// The caller is answered at once, though the mail server says "try later".
	code, body := post(t, s, testToken, `{"template":"mfa_code","to":"a@example.com","data":{"code":"123456"}}`)
	if code != 202 || body["queued"] != true {
		t.Fatalf("got %d %v", code, body)
	}
	if n, err := q.pass(ctx); err != nil || n != 1 || sender.count() != 0 {
		t.Fatalf("first pass took %d (%v), sent %d", n, err, sender.count())
	}
	var tries int
	var next time.Time
	var lastError string
	if err := q.db.QueryRow(ctx, `SELECT tries, next_try_at, last_error FROM mail_queue`).Scan(&tries, &next, &lastError); err != nil {
		t.Fatal(err)
	}
	if tries != 1 || time.Until(next) < 5*time.Second || lastError == "" {
		t.Fatalf("after a failed try: tries %d, next in %s, error %q", tries, time.Until(next), lastError)
	}
	// Not due yet: the next pass leaves it alone.
	if n, _ := q.pass(ctx); n != 0 {
		t.Fatalf("a pass took %d emails that were not due", n)
	}

	sender.set(false, false)
	due(t, q)
	if n, err := q.pass(ctx); err != nil || n != 1 {
		t.Fatalf("second pass took %d (%v)", n, err)
	}
	if sender.count() != 1 || sender.sent[0].To != "a@example.com" || sender.sent[0].Subject == "" {
		t.Fatalf("sent %v", sender.sent)
	}
	if n, _ := q.waiting(ctx); n != 0 {
		t.Fatalf("%d emails still waiting after it was sent", n)
	}
	due(t, q)
	if _, _ = q.pass(ctx); sender.count() != 1 {
		t.Fatal("the email went twice")
	}
}

func TestAnEmailRefusedForGoodOrTooOldIsDropped(t *testing.T) {
	sender := &flakySender{permanent: true}
	q := newQueue(t, sender)
	ctx := context.Background()
	if err := q.add(ctx, "auth", "invitation", Message{To: "nobody@example.com", Subject: "x", Text: "x"}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.pass(ctx); err != nil {
		t.Fatal(err)
	}
	if n, _ := q.waiting(ctx); n != 0 {
		t.Fatalf("an email refused for good is still waiting (%d)", n)
	}

	// A sign-in code that could not go out in its ten minutes is worth nothing: dropped, never sent late.
	sender.set(false, false)
	if err := q.add(ctx, "auth", "mfa_code", Message{To: "a@example.com", Subject: "code", Text: "123456"}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.db.Exec(ctx, `UPDATE mail_queue SET expires_at = now() - interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if _, err := q.pass(ctx); err != nil {
		t.Fatal(err)
	}
	if n, _ := q.waiting(ctx); n != 0 || sender.count() != 0 {
		t.Fatalf("a stale code: %d waiting, %d sent", n, sender.count())
	}
}

func TestTwoSendersNeverSendTheSameEmail(t *testing.T) {
	sender := &flakySender{}
	q := newQueue(t, sender)
	ctx := context.Background()
	for range 50 {
		if err := q.add(ctx, "crm-core", "report", Message{To: "a@example.com", Subject: "r", Text: "r"}); err != nil {
			t.Fatal(err)
		}
	}
	other := &queue{db: q.db, sender: sender, wake: make(chan struct{}, 1)}
	var wg sync.WaitGroup
	for _, each := range []*queue{q, other} {
		wg.Go(func() {
			for {
				if n, err := each.pass(ctx); err != nil || n == 0 {
					return
				}
			}
		})
	}
	wg.Wait()
	if sender.count() != 50 {
		t.Fatalf("50 emails, %d sent", sender.count())
	}
}

func TestWithoutItsDatabaseAnEmailIsSentAtOnce(t *testing.T) {
	ctx := context.Background()
	// A queue whose database cannot be reached (nothing listens on port 1).
	db, err := pgxpool.New(ctx, "postgres://nobody:x@127.0.0.1:1/none?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sender := &fakeSender{}
	s := newServer(map[string][]string{"auth": {testToken}}, sender, true)
	s.queue = &queue{db: db, sender: sender, wake: make(chan struct{}, 1)}
	code, body := post(t, s, testToken, `{"template":"mfa_code","to":"a@example.com","data":{"code":"123456"}}`)
	if code != 202 || body["queued"] != false || len(sender.sent) != 1 {
		t.Fatalf("got %d %v, sent %d", code, body, len(sender.sent))
	}
}

func TestOnlyAFiveHundredAnswerIsRefusedForGood(t *testing.T) {
	if !errors.Is(refusal("x", &textproto.Error{Code: 550}), errPermanent) {
		t.Fatal("550 should be for good")
	}
	for _, err := range []error{&textproto.Error{Code: 451}, errors.New("connection reset")} {
		if errors.Is(refusal("x", err), errPermanent) {
			t.Fatalf("%v should be tried again", err)
		}
	}
	for tries, most := range map[int]time.Duration{1: 10 * time.Second, 2: 20 * time.Second, 30: maxBackoff} {
		if wait := backoff(tries); wait > most || wait < most*4/5 {
			t.Fatalf("try %d waits %s", tries, wait)
		}
	}
}
