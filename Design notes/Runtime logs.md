# Caller Whale runtime logs

## Purpose

Use one readable table across application containers. A person should be able to scan down the service, method, status and duration columns without their positions changing. The service column also makes rows understandable when streams are combined.

This is the shared specification and implementation guide. Source: `Caller Whale CRM/tools/runtime-log/`. Last revised: 2 November 2026.

## Layout

```text
| RESULT     | SERVICE            | PAGE / EVENT             | METHOD  | HTTP | TIME (SEC)  | DETAIL / PATH
| [OK]       | Website            | Privacy page             | GET     | 200  |     0.003 s | /privacy
| [REJECTED] | Landing API        | Waitlist signup          | POST    | 403  |     0.001 s | /waitlist
| [WARN]     | Auth               | Service event            | -       | -    |           - | Configuration needs attention
| [START]    | Core API worker    | Process                  | -       | -    |           - | Starting container command
```

| Column | Width | Rule |
| --- | ---: | --- |
| RESULT | 10 | ASCII labels; no emoji or ANSI escapes that could render as byte codes. |
| SERVICE | 18 | Fixed label supplied by the image, not by a request. |
| PAGE / EVENT | 24 | Readable page or event name. Long labels end in `~`; details stay in the last column. |
| METHOD | 7 | GET, HEAD, POST, OPTIONS, etc., aligned vertically. Non-HTTP events use `-`. |
| HTTP | 4 | Actual response status; non-HTTP events use `-`. |
| TIME (SEC) | 11 | Right aligned, three decimal places and `s`. Non-request events use `-`. |
| DETAIL / PATH | Flexible | The final column can grow without moving earlier columns. |

Use a monospace log view. Narrow views may scroll horizontally. Enable the log viewer's timestamp display when chronological context is needed; Docker retains timestamps outside the application message.

## Status language

- `[CHECK]`: a startup check is running.
- `[PASS]`: a specific configuration check passed. It does not mean the whole app is healthy.
- `[START]`: the process is being started. Coolify's healthcheck determines readiness.
- `[OK]`: HTTP 2xx.
- `[REDIRECT]`: HTTP 3xx.
- `[REJECTED]`: HTTP 4xx, including missing routes. A 404 is not a server crash.
- `[ERROR]`: HTTP 5xx, an error-level service event, or process failure.
- `[WARN]`: a warning or an incomplete response.
- `[INFO]`: an ordinary event.
- `[STOP]`: the original command exited successfully.

Failed checks and diagnostics remain visible. The presentation adapter preserves normal exit codes, forwards termination signals, and does not turn failures into successful output. Standard maintenance commands (`health`, `new-key`, `setup-database`) keep their original CLI output.

## Coverage

The shared runner is installed in **18 application Dockerfiles**:

| Area | Containers |
| --- | --- |
| Landing | Website, Dashboard, Landing API |
| Platform | Auth, Gateway, Core API, Core API worker, Notifications, Grafana proxy, Billing |
| Feature services | Importing lists, Skip tracing, Dialer SMS, Leads map, CRM, AI campaigns, Exports, Backup restore |

All emitted stdout/stderr events use the shared table. Existing nginx request rows are normalized into the same widths; repeated native table headers are omitted. Node, Go and Rust HTTP adapters emit method, path, status and duration records. The Python feature scaffolds emit the same request record shape. Successful health probes are omitted; failed probes remain visible. Duration measures server-side handling: nginx/Node/Go record response handling, while Axum/Python records response creation. It is not browser page-load time and should not be compared as a cross-runtime benchmark.

The current new-VPS production environment was inspected during this change and contained Website, Landing API and Dashboard. Those three are the live rollout targets. Other image definitions become active when their services are deployed; publishing source does not create those services or configure their credentials.

## One source, independent deployment branches

`tools/runtime-log/main.go` is the canonical dependency-free Go runner. For local Docker builds, run the sync command below to generate ignored copies under each build context’s `runtime-log/main.go`. The production publisher injects the canonical source into each isolated branch snapshot automatically, so main keeps one runner source rather than 18 duplicate files. Isolated branches can then build without reaching into another branch. Docker compiles the runner as a static binary and keeps each application's existing command, user, healthcheck and application port.

Request adapters are maintained alongside the runner and synchronized to their consumers.

```powershell
# From Caller Whale CRM
node tools/runtime-log/sync.mjs
node tools/runtime-log/sync.mjs --check
```

Do not edit generated copies independently. A change to the standard must update the runner/adapters, synchronize them, run the behavior tests and refresh affected production branches.

## Combining streams

The standard produces a common format; each container still owns its own stdout/stderr stream. The runner also accepts `--stdin` for an existing stream. In that mode it preserves the service names of already formatted rows and prints one header.

For example, on a host where the runner is available:

```sh
# Combine already-formatted application services from a Compose project.
docker compose logs --follow --no-color --no-log-prefix website api dashboard \
  | callerwhale-log --stdin

# Present a native vendor stream without replacing its process or data image.
docker logs --follow --tail 100 postgres 2>&1 \
  | CALLERWHALE_LOG_SERVICE=PostgreSQL callerwhale-log --stdin
```

Replace example container/service names with the actual deployment names. Do not use the second command as a substitute for database monitoring or backups.

PostgreSQL, Redis, Grafana itself, and Coolify's own proxy/management containers are third-party infrastructure. Their images and native log streams are not replaced by these application Dockerfile changes. They can be presented through the stdin adapter or collected with service labels in a log backend. A persistent, hosted combined view needs a configured collector/storage destination; this change does not claim to provision one. Coolify's Deployment Logs remain build-system output, separate from these Runtime Logs.

## Privacy and diagnostic integrity

- HTTP adapters do not log request headers, cookies, authorization, or bodies.
- Strip query strings and fragments from request paths. Redact secret webhook path suffixes.
- The runner removes ANSI codes, escapes control characters and table delimiters, and redacts common credential assignments, URL credentials and email addresses.
- Redaction is additional protection, not permission to send secrets or personal records to a logger. New code must avoid emitting them at the source.
- Preserve useful warning/error details. Structured events retain their diagnostic fields; the logger does not print the same message twice.
- Keep complete rows atomic across stdout/stderr. Flush partial final lines and label large-line continuations rather than losing diagnostics.
- A truncated display label must not truncate the diagnostic detail or HTTP status.

## Verification before release

1. Check column widths across short/long names, GET/HEAD/OPTIONS, 2xx/4xx/5xx and different durations.
2. Check privacy, health suppression, concurrent output, incomplete lines and child exit-code handling.
3. Check that HTTP instrumentation preserves status, headers, body, flushing and proxy upgrades.
4. Build/check affected language services and run their existing tests.
5. Deploy the affected applications, confirm health, then inspect real request and startup rows in Coolify.
6. Record which services were actually deployed. Source coverage and live rollout are distinct facts.

The shared formatter and Node adapter have behavior tests in `tools/runtime-log`. Keep the server-side authentication and access checks independent of this presentation layer.
