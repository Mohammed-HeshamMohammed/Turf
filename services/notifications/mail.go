package main

// Email: the one place in Caller Whale that talks to the mail server and the one place the email templates live. Other services
// send {template, to, data} to POST /v1/mail with their service token; they never see the SMTP login or write a message.

import (
	"bytes"
	"crypto/tls"
	"errors"
	"fmt"
	"html"
	"mime"
	"mime/multipart"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"strings"
	"time"
)

// Message is one email, ready to send.
type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
}

// Sender sends a message. The real one is SMTP; tests use a fake that records it.
type Sender interface {
	Send(Message) error
}

// SMTP sends through the mail server: STARTTLS on 587 (or any port but 465), TLS on 465, never in the clear.
type SMTP struct {
	Host     string
	Port     string
	User     string
	Password string
	From     string
}

// Configured says whether the mail server and the sender address are both set.
func (s SMTP) Configured() bool {
	return strings.TrimSpace(s.Host) != "" && strings.TrimSpace(s.From) != ""
}

func (s SMTP) Send(m Message) error {
	from, err := mail.ParseAddress(s.From)
	if err != nil {
		return fmt.Errorf("the sender address is not an address: %w", err)
	}
	to, err := mail.ParseAddress(m.To)
	if err != nil {
		return fmt.Errorf("the recipient is not an address: %w", err)
	}
	body, err := build(from, to, m)
	if err != nil {
		return err
	}
	addr := net.JoinHostPort(s.Host, s.Port)
	dialer := &net.Dialer{Timeout: 20 * time.Second}
	var conn net.Conn
	if s.Port == "465" {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: s.Host, MinVersion: tls.VersionTLS12})
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("could not reach the mail server: %w", err)
	}
	_ = conn.SetDeadline(time.Now().Add(40 * time.Second))
	client, err := smtp.NewClient(conn, s.Host)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("the mail server did not greet us: %w", err)
	}
	defer client.Close()
	if s.Port != "465" {
		if err := client.StartTLS(&tls.Config{ServerName: s.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return fmt.Errorf("the mail server would not start TLS: %w", err)
		}
	}
	if s.User != "" {
		if err := client.Auth(smtp.PlainAuth("", s.User, s.Password, s.Host)); err != nil {
			return fmt.Errorf("the mail server refused the login: %w", err)
		}
	}
	if err := client.Mail(from.Address); err != nil {
		return fmt.Errorf("the mail server refused the sender: %w", err)
	}
	if err := client.Rcpt(to.Address); err != nil {
		return fmt.Errorf("the mail server refused the recipient: %w", err)
	}
	w, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(body); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("the mail server refused the message: %w", err)
	}
	return client.Quit()
}

// build writes the message with a plain-text part and, when there is one, an HTML part.
func build(from, to *mail.Address, m Message) ([]byte, error) {
	if strings.ContainsAny(m.Subject, "\r\n") {
		return nil, errors.New("the subject has a line break")
	}
	var out bytes.Buffer
	header := func(k, v string) { fmt.Fprintf(&out, "%s: %s\r\n", k, v) }
	header("From", from.String())
	header("To", to.String())
	header("Subject", mime.QEncoding.Encode("utf-8", m.Subject))
	header("Date", time.Now().UTC().Format(time.RFC1123Z))
	header("MIME-Version", "1.0")
	if m.HTML == "" {
		header("Content-Type", "text/plain; charset=utf-8")
		header("Content-Transfer-Encoding", "8bit")
		out.WriteString("\r\n")
		out.WriteString(strings.ReplaceAll(m.Text, "\n", "\r\n"))
		return out.Bytes(), nil
	}
	mp := multipart.NewWriter(&out)
	header("Content-Type", "multipart/alternative; boundary="+mp.Boundary())
	out.WriteString("\r\n")
	for _, part := range []struct{ kind, body string }{{"text/plain", m.Text}, {"text/html", m.HTML}} {
		w, err := mp.CreatePart(textproto.MIMEHeader{"Content-Type": {part.kind + "; charset=utf-8"}, "Content-Transfer-Encoding": {"8bit"}})
		if err != nil {
			return nil, err
		}
		_, _ = w.Write([]byte(strings.ReplaceAll(part.body, "\n", "\r\n")))
	}
	if err := mp.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// Render turns a template name and its data into a message for one recipient. Templates live here and nowhere else.
func Render(template, to string, data map[string]any) (Message, error) {
	str := func(k string) string {
		v, _ := data[k].(string)
		return strings.TrimSpace(v)
	}
	switch template {
	case "mfa_code":
		code := str("code")
		if code == "" || len(code) > 12 || strings.ContainsAny(code, " \r\n") {
			return Message{}, errors.New("mfa_code needs a short code")
		}
		return Message{
			To:      to,
			Subject: "Your Caller Whale code",
			Text:    code + " is your Caller Whale code. It works for 10 minutes. If you did not just try to sign in, ignore this and change your password.",
		}, nil
	case "invitation":
		inviter, link := str("inviter"), str("link")
		if inviter == "" || link == "" {
			return Message{}, errors.New("invitation needs inviter and link")
		}
		credits, _ := data["monthly_credits"].(float64)
		name := str("name")
		greeting := "Hello,"
		if name != "" {
			greeting = "Hello " + name + ","
		}
		n := thousands(int64(credits))
		text := greeting + "\n\n" + inviter + " has invited you to Caller Whale, the desktop app for your lists, Skip Tracing and calls.\n\n" +
			"Your account comes with " + n + " credits a month.\n\n" +
			"1. Create your account at " + link + " with this email address (" + to + "), or sign in with Google if it is a Google account.\n" +
			"2. Open your dashboard and download the desktop app.\n" +
			"3. Sign in to the app with the same account.\n\n" +
			"Only this email address can use the invitation.\n\n— Caller Whale"
		e := html.EscapeString
		page := `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1b1b1b;max-width:520px">` +
			"<p>" + e(greeting) + "</p>" +
			"<p><strong>" + e(inviter) + "</strong> has invited you to Caller Whale, the desktop app for your lists, Skip Tracing and calls.</p>" +
			"<p>Your account comes with <strong>" + n + " credits a month</strong>.</p>" +
			"<ol><li>Create your account with this email address (" + e(to) + "), or sign in with Google if it is a Google account.</li>" +
			"<li>Open your dashboard and download the desktop app.</li><li>Sign in to the app with the same account.</li></ol>" +
			`<p><a href="` + e(link) + `" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">Accept the invitation</a></p>` +
			`<p style="color:#666;font-size:13px">Only this email address can use the invitation.</p></div>`
		return Message{To: to, Subject: inviter + " invited you to Caller Whale", Text: text, HTML: page}, nil
	}
	return Message{}, errors.New("unknown template")
}

// thousands writes 12500 as "12,500".
func thousands(v int64) string {
	neg := v < 0
	if neg {
		v = -v
	}
	digits := fmt.Sprintf("%d", v)
	var b strings.Builder
	for i, c := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}
