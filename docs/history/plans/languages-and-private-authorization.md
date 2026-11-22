# Languages per job, and a private authorization service

Status: direction from the owner, 2026-11-04, with the points to settle before building. Nothing is built. It sits on top of `service-architecture.md` (one service owns its data, services talk through the gateway or the bus) and `core-api-language-decision.md` (the research).

## What the owner asked for

1. **Go for connection and network work** (gateway, auth, notifications, anything that mostly moves requests and waits).
2. **C++ for data work**: machine learning, automation, reports.
3. **Authorization in its own container**, with no public address, that only other machines can call.

## 1. Go for the network edge: agreed

This is what already exists (gateway, auth, the job worker) and what the research supports (fast to build, single static binary, goroutines for many connections). New edge services are written in Go.

## 2. C++ for data, ML, automation and reports: settle these first

C++ is a legitimate choice for heavy numeric work, and the repository already refers to a "C++ batch engine" (its source is not in the repo yet; find it and commit it). Points from the research and the code that the decision should answer:

- **Rust is about as fast as C++** for heavy computing (published comparison: similar overall, each ahead on different workloads), and it is memory-safe. C++ is not faster than the Rust that is already here; choose it for an existing C++ library or engine, or for team skill, not for speed.
- **Machine learning is rarely written in C++ by hand.** The usual route is Python (PyTorch, scikit-learn, ONNX) with the heavy kernels already in C++ underneath. Writing model training in raw C++ costs much more than calling those libraries. If a model must run fast in production, export it (ONNX) and serve it from a small service.
- **Reports and automation here are mostly database work** (the rules and reports are SQL over PostgreSQL). The database does the heavy lifting, so a faster language adds little; indexes, query plans and caching add more.
- **Safety**: a service that handles uploaded files and customer lists is a bigger risk in C++ (memory bugs become security holes). If C++ is used, run it in its own container with no secrets other than its own, a read-only file system where possible, and fuzz tests on every parser.
- **How Go and C++ talk**: through a private HTTP/gRPC call carrying whole batches (one request per job, thousands of rows), not by calling C++ from Go for each row. Calling C from Go costs about 100-200 ns per call; that is negligible per batch and ruinous per row. So: a **job worker** in Go leases a job, sends the batch to the C++ engine, stores the result.
- **Three toolchains**: Go, C++ (and Python for matching today) means three builds to keep working. Keep C++ to engines with one clear job and a small interface, so the build stays small.

Proposed split, to confirm:

| Job | Language | Why |
| --- | --- | --- |
| Gateway, auth, notifications, job leasing, webhooks | Go | network and waiting |
| Matching, grouping, deduplication, scoring over large lists | C++ engine (or Rust: the `grouping` crate exists) | compute over big batches; the engine is a private service or a worker-run binary |
| Reports and rules | SQL in PostgreSQL, run by the core API or a Go worker | database-bound |
| Machine learning | Python for training; ONNX or a small served model for production | the ML ecosystem |

## 3. A private authorization service

Today (read from the code): **auth** is the only place that proves who someone is (it signs tokens); the **core API** decides what they may do (it reads their membership and roles on every request); the **gateway** checks the token's signature and the staff second step.

The owner's wish: a separate container for authorization that **no person can reach, only machines**. Design:

- **What it answers**: "may this person (user, organisation, roles) do this action on this resource?" It returns allow or deny with a reason. It does not sign in anyone and does not issue tokens; that stays in auth.
- **Where it lives**: its own container on the private Coolify network, **no domain, no entry in the gateway's `ROUTES`**. People cannot reach it from the internet because nothing routes to it.
- **Who may call it**: only our own services. Each caller (gateway, core API, the Go workers) has its own machine token (long random secret, or a short-lived signed service token) and the service keeps an allow-list of callers and the questions each may ask. A call without a valid machine token is refused and logged.
- **Its own data**: its own database login and tables (roles, memberships, policies), per the rule "a service owns its data". Other services stop reading the memberships table directly and ask it.
- **Speed**: every request would now cost a network hop. Keep tokens verified locally (the signature check does not leave the caller). Callers cache each answer for a few seconds, and cache invalidation on a membership change goes over the event bus, so a removed person loses access within seconds. The hop is inside one machine's Docker network, so it is sub-millisecond when healthy.
- **When it is down**: callers **fail closed** (deny everything that is not a plain public page) and the health check pages the owner. It runs as more than one copy so one restart is not an outage.
- **Language**: Go (it is a small decision service with many connections), unless the policy language chosen brings its own engine.
- **Use a maintained policy engine** instead of inventing rules: Open Policy Agent, Cedar or SpiceDB are the usual choices. Pick one before writing code; the research for it has not been done yet.
- **What this does not do**: "only machines can access it" protects it from the internet. It does not protect against a compromised machine on the same network, so the service tokens, the allow-list and an audit log are part of the design, not extras.

## Order of work

1. **Find and commit the C++ batch engine's source**; write down its interface (input batch, output groups).
2. **Choose the policy engine** for authorization (OPA, Cedar or SpiceDB) with a small comparison.
3. **Authorization service v1**: the questions the core API already answers today (membership and role checks), same results, behind a feature switch; the core API asks it and compares answers with its own for a week.
4. **Move the core API's checks over**, then the gateway's staff check; remove the old code last.
5. **Matching engine as a private worker target**: the Go worker sends batches; results are checked against the Python reference path.
6. **Decide the core API language** only after the measurements in `core-api-language-decision.md` and the build fix (CI-built images), not before.

## Open questions

1. Where is the C++ batch engine, and who maintains it?
2. Is "reports and automation in C++" meant to replace SQL reports, or to run extra engines beside them?
3. Should authorization decide **only data access** (who sees which records) or also **feature access** (plans and credits)? Billing and credits are in the core API today.
4. Which policy engine, and does the team accept running one more container for it?
