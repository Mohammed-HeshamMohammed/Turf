# Core API: one language or several? (research for the decision)

Status: research, no decision yet. Written 2026-11-04 for the owner. The goal the owner set: **faster, higher performance, more efficient** (not cheaper). This document replaces the unstated assumption in `go-core-api.md` that moving to Go makes the core API faster. The research below does not support that assumption. Read it, then decide.

## What the core API actually is

Read from the code (`services/core-api/rust`, about 9,900 lines): a database-backed HTTP service. Its routes are CRM records (leads, tasks, deals, conversations), reports and rules, workspace admin, billing and webhooks, sync and a live-updates socket, staff pages and the website's forms. Almost every request is "check the token, read or write PostgreSQL, return JSON".

- **No C or C++ in it.** PostgreSQL is reached with `sqlx` (pure Rust), TLS is `rustls`, Redis with a Rust client. The image installs only `ca-certificates`.
- **One small native-style piece:** `crates/grouping` (277 lines, built as a library other programs can load). It must give identical groups "on the API, in workers and in offline Skip Tracing". Its comments say pair comparisons run in "the Python reference path or the C++ batch engine"; **no C++ source exists in this repository**, so that engine's location is unknown.
- **Already other languages:** the job worker is Go (`services/core-api/go`), a Python worker (254 lines) and the Skip Tracing engine are Python, auth and the gateway are Go, the websites are JavaScript, the desktop app is Rust (Tauri).

So the system is already multi-language. The question is only what the core API itself should be written in, and whether to keep more than one language on the servers.

## What the research found

Quality warning: almost every source is a blog post or forum thread. The one number found most often (Rust about 31% more requests per second than Go) appears to come from a single test (Markaicode, May 2025) that other posts repeat. **No reliable 2025 TechEmpower comparison of Rust and Go was found.** Treat all figures as directional and benchmark our own service before trusting any of them.

### 1. Raw speed: Rust is ahead, by a modest margin that shrinks when the database is the bottleneck

| Measure | Reported result | Source quality |
| --- | --- | --- |
| Requests per second, simple HTTP | Rust (Axum) about 187,000 vs Go (Gin) about 142,000 | one test, repeated by others |
| Same, other test | Rust (Actix) about 137,000 vs Go (Fiber) about 125,000 | hello-world, small gap |
| p99 latency | Rust 1.27 ms vs Go 1.85 ms | same single test |
| Memory | Rust 18 MB vs Go 28 MB for the same service | same test; other posts say Rust 50-80 MB vs Go 100-320 MB, method unstated |
| I/O-bound work | Go sometimes matches or beats Rust (a URL-shortener benchmark) | blog |

Plain reading: Rust is faster and uses less memory, but for a service that spends its time waiting on PostgreSQL the gap is small. The database, not the language, sets the speed of a CRM request.

### 2. Real rewrites: mixed, and expensive

- A team that benchmarked a Rust rewrite of its API found Go **faster on its real workload**; the rewrite never shipped and the post puts its cost at about $180,000 of engineering time, with roughly a 20% performance gap in an I/O-bound API.
- Grab moved a hot, high-traffic counter service from Go to Rust and reported a 70% cost cut; another case rewrote only the CPU-heavy endpoints, shadow-tested them against live traffic, and saw p99 latency drop about 76% (its savings figure was a projection).
- A startup reported that feature work slowed for a whole quarter after a Go to Rust port; another source says Rust can take two to three times longer to write.
- Discord's often-cited move from Go to Rust was about Go's garbage-collector pauses on a very large in-memory service.

The common thread in these accounts: **rewrite the hot path, measure against real traffic, do not rewrite everything.** None of them reports a speed-up from rewriting a working Rust service into Go.

### 3. Go's weak spot (garbage collection) is improving but not gone

Go 1.25 added an experimental "Green Tea" garbage collector reported to cut collection overhead by 10-40% on heavy workloads; early adopters saw mixed latency, one (Dolt) saw no real-world difference, and it is reported as default in Go 1.26 after fixes. No official pause-time figures were found. For a service of our size, garbage collection is unlikely to be the problem; it matters for huge in-memory services.

### 4. Calling C or C++ from Go (cgo) costs real time

Each call from Go into C costs roughly 100-200 ns (about 170 ns in one 2018 measurement; newer Go versions reportedly under 50 ns, unverified) against 1-5 ns for a normal Go call. It matters for many tiny calls and is negligible when each call does real work or is batched. It also adds a C compiler to the build and pins a thread during the call. **So a C or C++ engine does not belong inside a Go request path unless it is called in large batches.** Our matching and grouping fit that shape (large batches), so a C++ or Rust engine called once per job from Go is workable.

### 5. Rust versus C++ for heavy computing: roughly equal

A published comparison found Rust "similar to C++ with only minor disadvantage", with each ahead on different workloads (C++ faster on hash maps and trees, Rust better on large branch-heavy or allocation-heavy tests). There is no performance reason to add C++ where Rust already works; a reason would be an existing C++ library or engine.

### 6. One language versus several

General guidance (all secondary sources): each extra language adds a toolchain, runtime upgrades, security patching, CI and on-call knowledge. A second language pays off only where leaving it out costs more than supporting it. Small teams and early products usually do best with one dominant language and a second only for a measured hot spot. Netflix is cited as polyglot yet standardised on one main language. A "Go for most services, Rust for measured hot paths" split is a common pattern, but this was the researcher's synthesis, not a finding.

## Honest conclusion about the earlier plan

`go-core-api.md` proposed rewriting the Rust core API in Go. The reasons it gave were one language and speed of building. The research says:

- **For speed and efficiency alone, Rust is equal or better than Go.** A Go rewrite would not make the core API faster; if anything slightly slower with more memory.
- **For the people building it, Go is faster to write.** That is the real argument for Go, and it is a velocity argument, not a performance one.
- **The cost of a full rewrite is large and the evidence says to avoid it** unless a measured problem demands it.

## Options

| | A. Keep Rust, tune it | B. Rewrite in Go | C. Split by job |
| --- | --- | --- | --- |
| Core API | stays Rust | Go | stays Rust |
| Speed and memory | best of the three | slightly worse | best |
| Work | small: fix settings, tune queries | very large: about 9,900 lines, 15 setup files, the live socket | small now, grows with new services |
| Risk | lowest | highest (behaviour drift, quarter-long slowdown reported) | low |
| Languages on servers | Rust, Go, Python | Go, Python (Rust gone) | Rust for CPU-heavy and long-lived cores; Go for edges (gateway, auth, mail, workers); Python for matching |
| Best if | the service meets its speed targets | the team will mostly write Go and Rust is a drag | performance matters and the team can hold two languages |

Option C is what the system already is. Option A and C are the same for the core API today.

## Recommendation

1. **Do not rewrite the core API now.** Nothing in the research or in our own measurements says it is too slow, and the evidence says a rewrite to Go will not speed it up.
2. **Measure first** (one day of work): load-test the live core API through the gateway and record requests per second, p50 and p99 latency, CPU and memory, with the real database. Find where the time goes (database, JSON, auth check, live socket).
3. **Spend effort where the time goes.** For a database-bound service that is usually PostgreSQL: indexes, query plans (`EXPLAIN ANALYZE`), connection pool size, Redis caching of hot reads, avoiding one-query-per-row loops, and paging. These give larger gains than any language change.
4. **Keep the rule "Go for new servers"** for edge services (auth, gateway, notifications, workers) where building speed matters and traffic is simple, and **Rust for the core and for CPU-heavy engines**. That is two server languages plus Python for matching, which the research treats as acceptable when each has a clear job.
5. **Treat C or C++ as an engine, not a service language.** If a C++ batch matcher exists, call it in large batches from a job worker, never per request. Find where it lives and put its source under version control first.
6. **Revisit a rewrite only if** measurement shows the core API is a bottleneck that tuning cannot fix, or if the team cannot maintain Rust.

## What to do next

- Find the C++ batch engine and decide where its source lives.
- Run the measurements in step 2 and record them here.
- If the owner still wants one server language, decide that on velocity and hiring, not speed, and then use the order of work in `go-core-api.md`.

## Sources

- [Golang vs Rust: Which Language Wins for Backend in 2025? (Netguru)](https://www.netguru.com/blog/golang-vs-rust)
- [Rust vs Go Performance in 2025: Benchmark Tests for Microservices (Markaicode)](https://markaicode.com/rust-vs-go-performance-benchmarks-microservices-2025/)
- [Rust vs Go for Our API: One Was 3x Faster. The Other Shipped 3x Faster](https://medium.com/codex/rust-vs-go-for-our-api-one-was-3x-faster-the-other-shipped-3x-faster-175be1d792dc)
- [Rust vs Go: 40% Latency Gap in 2026 Benchmarks](https://tech-insider.org/rust-vs-go-2026/)
- [We Rewrote Our API in Rust for 20% Better Performance. It Cost Us $180K](https://levelup.gitconnected.com/we-rewrote-our-api-in-rust-for-20-better-performance-it-cost-us-180k-52d37711ffb3)
- [How Grab's Migration from Go to Rust Cut Costs by 70% (ByteByteGo)](https://blog.bytebytego.com/p/how-grabs-migration-from-go-to-rust)
- [2x Performance, $300k Savings: A Case Study in Rewriting a Critical Service in Rust](https://hn.jakechampion.name/reader/https://wxiaoyun.com/blog/rust-rewrite-case-study)
- [We Rewrote a Go Service in Rust and Our Velocity Tanked for a Quarter (DEV)](https://dev.to/adioof/we-rewrote-a-go-service-in-rust-and-our-velocity-tanked-for-a-quarter-27al)
- [Go Green Tea GC (InfoQ)](https://infoq.com/news/2025/11/go-green-tea-gc/)
- [Adventures in Cgo Performance (GopherCon 2018)](https://about.sourcegraph.com/go/gophercon-2018-adventures-in-cgo-performance)
- [Is Rust C++-fast? Benchmarking System Languages on Everyday Routines](https://deepai.org/publication/is-rust-c-fast-benchmarking-system-languages-on-everyday-routines)
- [6 best languages for building microservices (Chronosphere)](https://chronosphere.io/learn/best-languages-for-microservices/)
- [Polyglot Architecture in Practice (Ksolves)](https://www.ksolves.com/blog/java/polyglot-architecture-in-practice)
- [Go Database Patterns: GORM, sqlx, and pgx Compared](https://dasroot.net/posts/2025/12/go-database-patterns-gorm-sqlx-pgx-compared/)
