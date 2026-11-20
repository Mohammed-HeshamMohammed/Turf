# assistant

The helper chat on the Caller Whale website (the round button at the bottom right). Common questions are answered from a written script, free and always the same; everything else goes to an AI through [OpenRouter](https://openrouter.ai), within strict limits. It keeps no data: the conversation lives in the visitor's browser and is sent with each message.

| | |
| --- | --- |
| Language | Go |
| Port | 8109 |
| Public address | `assistant.callerwhale.com`, through the gateway (`ROUTES`), so the gateway's per-address limit applies first |
| Data | None. Message text is never logged (only "scripted", "ai" or "fallback" and the page) |
| Secret | `OPENROUTER_API_KEY`, in Coolify only. Without it the assistant still works from its script |

## What it does

`POST /v1/chat` with `{messages: [{role, content}], page}` answers `{source, answer: {reply, suggestions, link}}`.

1. **The script** (`script.go`) answers short questions about plans, trial, importing, calls, security, sign-up and contact, and runs the plan advisor: it asks how many people will call and recommends Solo, Duo, Team or Pro. No price is ever stated, because the prices are drafts.
2. **The AI** (`ai.go`) answers the rest, with instructions that keep it to Caller Whale, to the facts in `script.go`, and away from prices, legal advice and personal details. Every web address in a reply that is not the site's is removed, and replies are cut at 900 characters.
3. **The fallback** says it is not sure and points to the contact page, when there is no key, the AI fails, or a limit is reached.

## Limits (all adjustable)

| Setting | Default | What it stops |
| --- | --- | --- |
| `ASSISTANT_MESSAGES_PER_MINUTE` | 12 per visitor | Floods |
| `ASSISTANT_AI_PER_VISITOR_PER_DAY` | 30 | One person running up the bill |
| `ASSISTANT_AI_PER_DAY` | 2000 | The bill as a whole: when it is spent, everyone gets the script |

Messages are at most 600 characters, a conversation at most 12 messages, and the AI answers at most 350 tokens.

## Run and test

```bash
go test ./...
```

The AI is tested against a fake OpenRouter; no key is needed. Settings: [env/assistant.production.example](../../env/assistant.production.example). Coolify: branch `assistant-backend-production`, Dockerfile `/Dockerfile`, port 8109, then add `assistant.callerwhale.com=http://assistant:8109` to the gateway's `ROUTES` (and the site's address to its `CORS_ORIGINS`).

## The in-app assistant (build step 26)

`POST /v1/agent/complete {task, facts, request}` with `Authorization: Bearer <AGENT_TOKEN>`, for crm-core and dialer-sms only (the gateway never forwards `/v1/` from outside). Tasks: `lead_summary`, `draft_text`, `draft_email`, `call_summary` (ending in an `OUTCOME:` line) and `howto`. The facts and the request are data, never instructions; neither is logged. Answers are drafts: nothing is sent or saved here. Without `AGENT_TOKEN` or `OPENROUTER_API_KEY` it answers 401 or 503.
