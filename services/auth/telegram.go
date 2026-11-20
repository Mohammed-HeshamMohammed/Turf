package main

// Telegram, for the second step: a bot that sends a six-digit code to a chat the person linked. The bot is optional: with no token
// this service does not offer Telegram. A person links their chat by opening a one-time link, t.me/<bot>?start=<code>, and
// Telegram then tells /v1/mfa/telegram/webhook/<secret> which chat sent it. Two plain HTTPS calls; a library would add more than it
// saves.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type telegram struct {
	token string
	bot   string // the bot's name without the @
	base  string // https://api.telegram.org (a stand-in in tests)
	http  *http.Client
}

func newTelegram(token, bot, base string) *telegram {
	return &telegram{token: token, bot: strings.TrimPrefix(strings.TrimSpace(bot), "@"), base: strings.TrimRight(base, "/"), http: &http.Client{Timeout: 15 * time.Second}}
}

func (t *telegram) send(ctx context.Context, chatID, text string) error {
	raw, _ := json.Marshal(map[string]any{"chat_id": chatID, "text": text})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.base+"/bot"+t.token+"/sendMessage", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := t.http.Do(req)
	if err != nil {
		return fmt.Errorf("telegram could not be reached") // not err: its text holds the bot token in the address
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("telegram answered %d", res.StatusCode)
	}
	return nil
}

// messageOf is the chat and the text of an update Telegram posted to the webhook, when it is a plain message.
func messageOf(update map[string]any) (chat, text string, ok bool) {
	message, _ := update["message"].(map[string]any)
	chatInfo, _ := message["chat"].(map[string]any)
	id, isNumber := chatInfo["id"].(float64)
	body, isText := message["text"].(string)
	if !isNumber || !isText {
		return "", "", false
	}
	return strconv.FormatInt(int64(id), 10), body, true
}
