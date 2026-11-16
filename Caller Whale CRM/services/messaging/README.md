# messaging

Conversations between the people of a workspace: direct chats and groups, with replies, mentions, reactions, polls, edits, deletes
and unread counts. Later it also holds text threads with leads; the `sms` service will only carry them. Plan:
[messaging-sms-voice.md](../../docs/plans/messaging-sms-voice.md), detail in
[messaging-sms-voice-detail.md](../../docs/plans/messaging-sms-voice-detail.md).

**Status (2026-11-14):** the service, its tables and its tests are written and pass against a local PostgreSQL. It has not been run in
a container, against the real authorization service, or against a real Centrifugo. The CRM's Inbox does not use it yet.

## How it works

- **Who:** sign-in tokens from the auth service are checked locally (`token.go`, copied by `tools/auth-verify/sync.mjs`). The
  authorization service says whether the person is in the workspace and may use conversations (the `message` capability; clients
  who only see shared records may not).
- **Storage:** PostgreSQL, schema `messaging`, row security on every table. A request sees only its workspace, and only the
  conversations the person is in, whatever a query forgets to say.
- **Which login:** row security does not apply to a superuser, and a database made by Coolify hands out one. So when the login is a
  superuser, the service makes a restricted role of its own (`messaging_app`: no login, no superuser, no bypass) at every start and
  runs each request as it. An ordinary login is used as it is. A login that bypasses row security without being a superuser makes the
  service refuse to start.
- **Order:** every message takes the next number in its conversation. Apps ask for "everything after number N" to catch up, so
  order never depends on clocks and a gap is visible.
- **Sending twice:** the app makes a message's id before sending. The same id again answers with the message as first saved.
- **Unread:** one number per person per conversation (the last message number they have read).
- **Live updates:** each change writes a row to `outbox` in the same transaction. A sender reads it in order and hands it to
  Centrifugo, which holds the apps' sockets. Each person listens on one channel of their own, `chat:user#<their id>`. A live
  update is only a prompt; the database is the truth.

## API

All under `/api/v1/messaging`, with `Authorization: Bearer <sign-in token>` and, except `/live`, `x-callerwhale-org: <workspace id>`.

| Request | Does |
| --- | --- |
| `GET /live` | Where to open the socket, the person's channel and a ten-minute token for it |
| `GET /conversations` | The person's conversations, newest first, each with its members, unread count and last message |
| `POST /conversations` `{kind: "direct" \| "group", title, member_ids}` | Starts one. A direct chat that exists is answered, not duplicated |
| `GET /conversations/{id}` | One conversation |
| `PATCH /conversations/{id}` `{title, archived, muted}` | Renames a group (its owner), or changes the person's own settings |
| `POST /conversations/{id}/members` `{add, remove}` | The owner adds or removes people; anyone may remove themselves |
| `POST /conversations/{id}/read` `{seq}` | Marks read up to a message number |
| `GET /conversations/{id}/messages?after=&before=&limit=` | Messages, oldest first: after a number, before one, or the newest |
| `POST /conversations/{id}/messages` `{id, body, reply_to, mentions, poll}` | Sends a message or a poll |
| `PATCH /messages/{id}` `{body}`, `DELETE /messages/{id}` | Edits or deletes the person's own message |
| `PUT` / `DELETE /messages/{id}/reactions/{emoji}` | Adds or takes back a reaction |
| `POST /messages/{id}/vote` `{option}` | Votes in a poll; again moves the vote, `null` takes it back |

Live updates carry `type` (`conversation`, `message`, `message_changed`, `read`), `org_id`, `conversation_id` and, for messages, the message.

## Settings

| Variable | Meaning |
| --- | --- |
| `PORT` | Default 8108 |
| `DATABASE_URL` | PostgreSQL. A superuser login works (requests run as `messaging_app`); one that bypasses row security without being a superuser is refused |
| `AUTH_JWKS_URL` | The auth service's public keys |
| `AUTHZ_URL`, `AUTHZ_TOKEN` | The authorization service and this service's token there (`messaging=...` in its `AUTHZ_TOKENS`) |
| `CORS_ORIGINS` | Pages that may call from a browser |
| `LIVE_API_URL`, `LIVE_API_KEY` | Centrifugo's server API and its key. Without them messages are saved and nothing is delivered live |
| `LIVE_TOKEN_SECRET` | Centrifugo's client token secret; connection tokens are signed with it |
| `LIVE_PUBLIC_URL` | Where apps open the socket |

## Tests

```bash
go test ./...
```

The database tests need `MESSAGING_TEST_ADMIN_URL` (a superuser, to reset the schema) and `MESSAGING_TEST_DATABASE_URL` (an
ordinary login) and are skipped without them. GitHub runs them in `.github/workflows/check-backend.yml`.

## Not done yet

- The CRM's Inbox still shows its sample conversations.
- Attachments, search, and notifications when the app is closed.
- Text threads with leads (`kind = 'lead'`, team notes): the columns exist, the requests do not.
- The Centrifugo settings in `services/live/config.json` (the live server's own folder) and `deploy/compose.yml` are written from its documentation; the container has not been built or run locally (no Docker on the build machine).
