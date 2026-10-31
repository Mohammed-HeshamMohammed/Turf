# Our own mail server

**Moved (2026-10-28).** The mail server is its own project with its own repository, `Mohammed-HeshamMohammed/Mail-Server` (local copy: `D:\Mail-Server`), and its own Coolify project, `mail`. Its plan, findings and progress are in that repository's `PLAN.md`.

What Caller Whale needs from it: an SMTP address and a login. `smtp.softfix.dev:587` with the mailbox `no-reply@softfix.dev` (STARTTLS). Only the notification service talks to it (env/notifications.production.example): auth and the core API ask it to send, with a token. Before that, auth writes "send this email" events to its outbox, and the notifications service (a placeholder today) is meant to read them and send through that server.
