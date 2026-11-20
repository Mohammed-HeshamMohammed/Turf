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
	ReplyTo string // optional: where a reply goes (the person who wrote through the contact form)
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
	if m.ReplyTo != "" {
		reply, err := mail.ParseAddress(m.ReplyTo)
		if err != nil {
			return nil, errors.New("the reply address is not an address")
		}
		header("Reply-To", reply.String())
	}
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
	case "confirm_email":
		link := str("link")
		if link == "" || !strings.HasPrefix(link, "https://") && !strings.HasPrefix(link, "http://") {
			return Message{}, errors.New("confirm_email needs a link")
		}
		name := str("name")
		greeting := "Hello,"
		if name != "" {
			greeting = "Hello " + name + ","
		}
		text := greeting + "\n\nConfirm your email address to finish setting up your Caller Whale account:\n\n" + link + "\n\nThe link works once and expires in 2 days. If you did not create an account, ignore this email.\n\n— Caller Whale"
		e := html.EscapeString
		page := `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1b1b1b;max-width:520px">` +
			"<p>" + e(greeting) + "</p><p>Confirm your email address to finish setting up your Caller Whale account.</p>" +
			`<p><a href="` + e(link) + `" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">Confirm my email</a></p>` +
			`<p style="color:#666;font-size:13px">The link works once and expires in 2 days. If you did not create an account, ignore this email.</p></div>`
		return Message{To: to, Subject: "Confirm your Caller Whale email", Text: text, HTML: page}, nil
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
	case "team_invitation":
		inviter, role, link := str("inviter"), str("role"), str("link")
		if inviter == "" || role == "" || link == "" {
			return Message{}, errors.New("team invitation needs inviter, role and link")
		}
		// role_name is the role in words ("Team manager"); expires says how long the invitation works ("72 hours").
		if name := str("role_name"); name != "" {
			role = name
		}
		expires := str("expires")
		if expires == "" {
			expires = "one hour"
		}
		// agency is the name of the agency inviting ("Blue Door Homes"); without it the email says Caller Whale, as before.
		agency := strings.TrimSpace(str("agency"))
		if strings.ContainsAny(agency, "\r\n") || len(agency) > 200 {
			agency = ""
		}
		where, subject := "Caller Whale", "Your Caller Whale invitation"
		if agency != "" && agency != "Caller Whale" {
			where, subject = agency+" on Caller Whale", "Join "+agency+" on Caller Whale"
		}
		e := html.EscapeString
		text := inviter + " invited you to join " + where + " as " + role + ".\n\nOpen the invitation: " + link + "\n\nSign in or create an account with " + to + ", confirm your email, then accept it. This invitation expires " + expires + " after it was created.\n\nOnly this email address can accept it. If you did not expect it, you can report it from the invitation page."
		page := `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1b1b1b;max-width:520px"><p><strong>` + e(inviter) + `</strong> invited you to join <strong>` + e(where) + `</strong> as <strong>` + e(role) + `</strong>.</p><p>Sign in or create an account with ` + e(to) + `, confirm your email, then accept it. This invitation expires ` + e(expires) + ` after it was created.</p><p><a href="` + e(link) + `" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">Open the invitation</a></p><p style="color:#666;font-size:13px">Only this email address can accept it. If you did not expect it, you can report it from the invitation page.</p></div>`
		return Message{To: to, Subject: subject, Text: text, HTML: page}, nil
	case "contact":
		// A message from the website's contact form, sent to the team's inbox (the "to"). The writer's address is the reply address.
		from, message := str("email"), str("message")
		writer, err := mail.ParseAddress(from)
		if err != nil || writer.Name != "" || message == "" || len(message) > 4000 {
			return Message{}, errors.New("contact needs the writer's email and a message")
		}
		name := str("name")
		if len(name) > 120 || strings.ContainsAny(name, "\r\n") {
			return Message{}, errors.New("contact needs a short name")
		}
		label := writer.Address
		if name != "" {
			label = name + " <" + writer.Address + ">"
		}
		text := "From the contact form on the website:\n\n" + label + "\n\n" + message + "\n\nReply to this email to answer them."
		e := html.EscapeString
		page := `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1b1b1b;max-width:560px">` +
			"<p><strong>" + e(label) + "</strong> wrote through the contact form:</p>" +
			`<p style="white-space:pre-wrap">` + e(message) + "</p>" +
			`<p style="color:#666;font-size:13px">Reply to this email to answer them.</p></div>`
		return Message{To: to, ReplyTo: writer.Address, Subject: "Contact form: " + subjectOf(name, writer.Address), Text: text, HTML: page}, nil
	case "report":
		// A scheduled report from the CRM (step 32): totals only; the details open in Caller Whale (D227). No lead is named here.
		agency, period, link := str("agency"), str("period"), str("link")
		lines, _ := data["lines"].([]any)
		if agency == "" || period == "" || !strings.HasPrefix(link, "https://") || len(lines) == 0 || len(lines) > 20 ||
			strings.ContainsAny(agency+period, "\r\n") || len(agency) > 200 || len(period) > 80 {
			return Message{}, errors.New("report needs agency, period, lines and an https link")
		}
		e := html.EscapeString
		var text, rows strings.Builder
		for _, l := range lines {
			m, _ := l.(map[string]any)
			label, _ := m["label"].(string)
			value := fmt.Sprint(m["value"])
			if v, ok := m["value"].(float64); ok {
				value = thousands(int64(v))
			}
			if label == "" || len(label) > 80 {
				return Message{}, errors.New("each report line needs a short label")
			}
			text.WriteString(label + ": " + value + "\n")
			rows.WriteString(`<tr><td style="padding:4px 16px 4px 0">` + e(label) + `</td><td style="text-align:right"><strong>` + e(value) + `</strong></td></tr>`)
		}
		body := agency + ", " + period + "\n\n" + text.String() + "\nThe details: " + link + "\n\nYou get this because a report was scheduled for you in Caller Whale."
		page := `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1b1b1b;max-width:520px"><p><strong>` +
			e(agency) + `</strong>, ` + e(period) + `</p><table>` + rows.String() + `</table><p><a href="` + e(link) +
			`" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">Open the details</a></p>` +
			`<p style="color:#666;font-size:13px">You get this because a report was scheduled for you in Caller Whale.</p></div>`
		return Message{To: to, Subject: agency + ": " + period, Text: body, HTML: page}, nil
	case "status":
		// Something is down, or back (step 34, D235): to the people who chose these emails.
		title, message, link := str("title"), str("message"), str("link")
		if title == "" || len(title) > 160 || strings.ContainsAny(title, "\r\n") || len(message) > 2000 || !strings.HasPrefix(link, "https://") {
			return Message{}, errors.New("status needs a title and an https link")
		}
		e := html.EscapeString
		text := title + "\n\n" + message + "\n\nSee the status page: " + link + "\n\nYou get this because you chose status emails in Caller Whale."
		page := `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1b1b1b;max-width:520px"><p><strong>` +
			e(title) + `</strong></p><p style="white-space:pre-wrap">` + e(message) + `</p><p><a href="` + e(link) + `">See the status page</a></p>` +
			`<p style="color:#666;font-size:13px">You get this because you chose status emails in Caller Whale.</p></div>`
		return Message{To: to, Subject: title, Text: text, HTML: page}, nil
	case "support_reply":
		// Caller Whale's staff answered an agency's support conversation (step 40, D292).
		title, message, link := str("title"), str("message"), str("link")
		if title == "" || len(title) > 160 || strings.ContainsAny(title, "\r\n") || message == "" || len(message) > 2000 || !strings.HasPrefix(link, "https://") {
			return Message{}, errors.New("support_reply needs a title, the message and an https link")
		}
		e := html.EscapeString
		text := title + "\n\n" + message + "\n\nRead and reply: " + link + "\n\nYou get this because you wrote to Caller Whale support."
		page := `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1b1b1b;max-width:520px"><p><strong>` +
			e(title) + `</strong></p><p style="white-space:pre-wrap">` + e(message) + `</p><p><a href="` + e(link) + `">Read and reply</a></p>` +
			`<p style="color:#666;font-size:13px">You get this because you wrote to Caller Whale support.</p></div>`
		return Message{To: to, Subject: title, Text: text, HTML: page}, nil
	case "breach_notice":
		// A security breach affecting the agency's data, to its owner within 72 hours (step 34, D236). The words are staff's; the
		// lawyer sets what else must be said.
		what, toDo, discovered := str("what"), str("to_do"), str("discovered")
		if what == "" || toDo == "" || discovered == "" || len(what) > 5000 || len(toDo) > 5000 {
			return Message{}, errors.New("breach_notice needs what happened, what to do and when it was found")
		}
		e := html.EscapeString
		text := "We are writing to tell you about a security incident that affected your agency's data in Caller Whale.\n\nWhen we learned of it: " + discovered +
			"\n\nWhat happened:\n" + what + "\n\nWhat you should do:\n" + toDo + "\n\nReply to this email with any question. We will tell you of anything new we learn.\n\n— Caller Whale"
		page := `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1b1b1b;max-width:560px">` +
			`<p>We are writing to tell you about a security incident that affected your agency's data in Caller Whale.</p>` +
			`<p><strong>When we learned of it:</strong> ` + e(discovered) + `</p><p><strong>What happened</strong></p><p style="white-space:pre-wrap">` + e(what) +
			`</p><p><strong>What you should do</strong></p><p style="white-space:pre-wrap">` + e(toDo) + `</p><p>Reply to this email with any question. We will tell you of anything new we learn.</p></div>`
		return Message{To: to, Subject: "Important: a security incident affecting your Caller Whale data", Text: text, HTML: page}, nil
	case "new_sign_in":
		// A sign-in from a device the person never used (step 35, D242), with a way to end it.
		device, place, at, link := str("device"), str("place"), str("at"), str("link")
		if device == "" || at == "" || !strings.HasPrefix(link, "http") || len(device) > 80 || len(place) > 80 || strings.ContainsAny(device+place, "\r\n") {
			return Message{}, errors.New("new_sign_in needs the device, the time and a link")
		}
		e := html.EscapeString
		text := "Someone signed in to your Caller Whale account from a new device.\n\nDevice: " + device + "\nWhere: " + place + "\nWhen: " + at +
			"\n\nIf it was you, there is nothing to do.\n\nIf it wasn't you, sign that device out and choose a new password: " + link + "\n\n— Caller Whale"
		page := `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1b1b1b;max-width:520px">` +
			`<p>Someone signed in to your Caller Whale account from a new device.</p><p><strong>Device:</strong> ` + e(device) + `<br><strong>Where:</strong> ` + e(place) +
			`<br><strong>When:</strong> ` + e(at) + `</p><p>If it was you, there is nothing to do.</p>` +
			`<p><a href="` + e(link) + `" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">This wasn't me</a></p>` +
			`<p style="color:#666;font-size:13px">The button signs that device out and emails you a link to choose a new password.</p></div>`
		return Message{To: to, Subject: "New sign-in to your Caller Whale account", Text: text, HTML: page}, nil
	}
	return Message{}, errors.New("unknown template")
}

// subjectOf names the writer in a subject line: their name when given, else their address.
func subjectOf(name, address string) string {
	if name != "" {
		return name
	}
	return address
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
