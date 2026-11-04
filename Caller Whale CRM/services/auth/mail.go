package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// mailer is what this service asks of the notification service: it never talks to a mail server and holds no mail login or
// template. An interface, so tests catch what would be sent instead of sending it.
type mailer interface {
	sendConfirmation(ctx context.Context, to, name, link string) error
	sendCode(ctx context.Context, to, code string) error
	sendInvitation(ctx context.Context, to, inviter, role, link string) error
}

type notify struct {
	url, token string
	http       *http.Client
}

func newNotify(url, token string) *notify {
	return &notify{url: url, token: token, http: &http.Client{Timeout: 30 * time.Second}}
}

func (n *notify) post(ctx context.Context, body map[string]any) error {
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.url+"/v1/mail", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+n.token)
	res, err := n.http.Do(req)
	if err != nil {
		return fmt.Errorf("the notification service could not be reached")
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("the notification service refused the message (%d)", res.StatusCode)
	}
	return nil
}

func (n *notify) sendConfirmation(ctx context.Context, to, name, link string) error {
	return n.post(ctx, map[string]any{"template": "confirm_email", "to": to, "data": map[string]any{"name": name, "link": link}})
}

func (n *notify) sendCode(ctx context.Context, to, code string) error {
	return n.post(ctx, map[string]any{"template": "mfa_code", "to": to, "data": map[string]any{"code": code}})
}

func (n *notify) sendInvitation(ctx context.Context, to, inviter, role, link string) error {
	return n.post(ctx, map[string]any{"template": "team_invitation", "to": to, "data": map[string]any{"inviter": inviter, "role": role, "link": link}})
}
