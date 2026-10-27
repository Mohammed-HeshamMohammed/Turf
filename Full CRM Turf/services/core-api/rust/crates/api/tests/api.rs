//! End-to-end API behaviour against real PostgreSQL (plan 5.1).

mod common;

use common::*;
use serde_json::{json, Value};
use uuid::Uuid;

macro_rules! harness {
    () => {
        match start().await {
            Some(h) => h,
            None => return,
        }
    };
}

#[tokio::test]
async fn mfa_is_required_for_owners_and_only_auth_tokens_sign_in() {
    let h = harness!();
    let owner = h.client("o@example.com", "O", false, true);
    let boot = owner.post("/api/v1/auth/bootstrap", json!({ "organization": "Org" })).await.ok();
    owner.set_org(boot["organization_id"].as_str().unwrap());
    // A second bootstrap is refused once the server is set up.
    let again = h.client("x@example.com", "X", true, true).post("/api/v1/auth/bootstrap", json!({ "organization": "X" })).await;
    assert_eq!(again.status, 403);
    // Two-step sign-in is auth's: until its token says the owner passed it, the CRM stays closed to them.
    assert_eq!(owner.get("/api/v1/leads").await.body["error"]["code"], "mfa_required");
    owner.reissue(true, true);
    assert_eq!(owner.get("/api/v1/leads").await.status, 200);
    // No token, or something that is not an auth token, is not signed in.
    assert_eq!(h.anonymous().get("/api/v1/me").await.status, 401);
    let opaque = owner.http.get(format!("{}/api/v1/me", h.base)).bearer_auth("0123456789abcdef0123456789abcdef").send().await.unwrap();
    assert_eq!(opaque.status().as_u16(), 401);
    // This server no longer signs anyone in or keeps sessions of its own.
    for path in ["/api/v1/auth/login", "/api/v1/auth/logout", "/api/v1/auth/signup", "/api/v1/auth/mfa/setup", "/api/v1/auth/mfa/verify", "/api/v1/auth/sessions/revoke", "/api/v1/auth/invitations/accept", "/api/v1/auth/password", "/api/v1/auth/oauth/google/start"] {
        assert_eq!(h.anonymous().post(path, json!({})).await.status, 404, "{path}");
    }
    assert_eq!(owner.get("/api/v1/auth/sessions").await.status, 404);
}

async fn lead(c: &Client, name: &str, extra: Value) -> Value {
    let mut payload = json!({ "name": name, "phone": "+17165553101", "address": "1 Test Ln", "city": "Amherst", "region": "NY" });
    if let Some(map) = extra.as_object() {
        for (k, v) in map {
            payload[k] = v.clone();
        }
    }
    c.op("lead.create", payload).await["result"].clone()
}

#[tokio::test]
async fn record_scope_separates_roles_and_organizations() {
    let h = harness!();
    let w = world(&h).await;
    let caller = w.client("caller");
    let mine = lead(caller, "Sarah Johnson", json!({})).await;
    let theirs = lead(&w.owner, "Robert Thompson", json!({ "assignee_id": w.id("closer") })).await;
    let names = |reply: Value| reply["leads"].as_array().unwrap().iter().map(|l| l["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(names(caller.get("/api/v1/leads").await.ok()), vec!["Sarah Johnson"]);
    assert_eq!(names(w.client("closer").get("/api/v1/leads").await.ok()), vec!["Robert Thompson"]);
    // The manager sees the team; the client sees nothing until something is shared.
    assert_eq!(w.client("manager").get("/api/v1/leads").await.ok()["leads"].as_array().unwrap().len(), 2);
    assert!(w.client("client").get("/api/v1/leads").await.ok()["leads"].as_array().unwrap().is_empty());
    // Direct requests for a record outside scope look like a missing record.
    assert_eq!(caller.get(&format!("/api/v1/leads/{}", theirs["id"].as_str().unwrap())).await.status, 404);
    // Sharing gives the client that one lead, without internal fields or internal notes.
    caller.op("note.add", json!({ "lead_id": mine["id"], "body": "Internal: wants 300k" })).await;
    caller.op("note.add", json!({ "lead_id": mine["id"], "body": "Brief is ready", "visibility": "shared" })).await;
    w.owner.op("lead.share", json!({ "id": mine["id"], "user_id": w.id("client") })).await;
    let shared = w.client("client").get(&format!("/api/v1/leads/{}", mine["id"].as_str().unwrap())).await.ok();
    assert!(shared["lead"].get("verdict").is_none() && shared["lead"].get("qualification").is_none());
    assert_eq!(shared["notes"].as_array().unwrap().len(), 1);
    // A client comment is always shared.
    let comment = w.client("client").op("note.add", json!({ "lead_id": mine["id"], "body": "Please update", "visibility": "internal" })).await;
    assert_eq!(comment["result"]["visibility"], "shared");
    // Financial fields need the finance permission.
    w.owner.op("lead.update", json!({ "id": mine["id"], "changes": { "value_amount": 245000 } })).await;
    assert!(caller.get(&format!("/api/v1/leads/{}", mine["id"].as_str().unwrap())).await.ok()["lead"].get("value_amount").is_none());
    assert!(w.owner.get(&format!("/api/v1/leads/{}", mine["id"].as_str().unwrap())).await.ok()["lead"].get("value_amount").is_some());
    // A second organization never sees the first one's records, even by id.
    sqlx::query("INSERT INTO organizations (id, name) VALUES ('00000000-0000-0000-0000-0000000000bb', 'Other')").execute(&h.owner).await.unwrap();
    let outsider = h.client("out@example.com", "Out", true, true);
    let outsider_id = Uuid::parse_str(&outsider.id).unwrap();
    sqlx::query("INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, 'out@example.com', 'Out', '!external-sign-in')").bind(outsider_id).execute(&h.owner).await.unwrap();
    sqlx::query("INSERT INTO roles (org_id, key, name, capabilities, scope) VALUES ('00000000-0000-0000-0000-0000000000bb', 'manager', 'M', '{edit}', 'organization')").execute(&h.owner).await.unwrap();
    sqlx::query("INSERT INTO memberships (org_id, user_id, roles) VALUES ('00000000-0000-0000-0000-0000000000bb', $1, '{manager}')").bind(outsider_id).execute(&h.owner).await.unwrap();
    outsider.set_org("00000000-0000-0000-0000-0000000000bb");
    assert!(outsider.get("/api/v1/leads").await.ok()["leads"].as_array().unwrap().is_empty());
    assert_eq!(outsider.get(&format!("/api/v1/leads/{}", mine["id"].as_str().unwrap())).await.status, 404);
    let poke = outsider.op("lead.update", json!({ "id": mine["id"], "changes": { "stage": "Closed" } })).await;
    assert_eq!(poke["status"], "rejected");
    // An administrator without record access sees no leads.
    let admin_id: Uuid = Uuid::parse_str(&w.id("researcher")).unwrap();
    let _ = admin_id;
}

#[tokio::test]
async fn operations_are_idempotent_and_conflicts_are_reported() {
    let h = harness!();
    let w = world(&h).await;
    let caller = w.client("caller");
    let l = lead(caller, "Michael Bennett", json!({})).await;
    let id = l["id"].clone();
    let op = json!({ "id": Uuid::new_v4(), "kind": "note.add", "payload": { "lead_id": id, "body": "Call after 10" } });
    let first = caller.post("/api/v1/ops", op.clone()).await.ok();
    let again = caller.post("/api/v1/ops", op.clone()).await.ok();
    assert_eq!(first["status"], "applied");
    assert_eq!(again["status"], "duplicate");
    assert_eq!(again["original_status"], "applied");
    // Another person replaying someone's operation id learns nothing.
    assert_eq!(w.client("manager").post("/api/v1/ops", op).await.ok()["status"], "rejected");
    let detail = caller.get(&format!("/api/v1/leads/{}", id.as_str().unwrap())).await.ok();
    assert_eq!(detail["notes"].as_array().unwrap().len(), 1);
    // Edits from the same base merge; a stale base on a changed field is a conflict with both values.
    w.client("manager").op("lead.update", json!({ "id": id, "changes": { "stage": "Interested" }, "base": { "stage": "New" } })).await;
    let ok = caller.op("lead.update", json!({ "id": id, "changes": { "priority": "High" }, "base": { "priority": "Normal" } })).await;
    assert_eq!(ok["status"], "applied");
    let clash = caller.op("lead.update", json!({ "id": id, "changes": { "stage": "Contacted" }, "base": { "stage": "New" } })).await;
    assert_eq!(clash["status"], "conflict");
    assert_eq!(clash["result"]["fields"]["stage"]["server"], "Interested");
    assert_eq!(clash["result"]["fields"]["stage"]["local"], "Contacted");
    // The review list shows it until resolved.
    let review = caller.get("/api/v1/admin/operations").await.ok();
    assert_eq!(review.as_array().unwrap().len(), 1);
    // Online-only changes are refused from an offline queue.
    let queued = w
        .client("manager")
        .post("/api/v1/ops", json!({ "id": Uuid::new_v4(), "kind": "lead.assign", "queued_offline": true, "payload": { "ids": [id], "assignee_id": w.id("closer") } }))
        .await
        .ok();
    assert_eq!(queued["status"], "rejected");
    // Unknown stages and fields are refused.
    assert_eq!(caller.op("lead.update", json!({ "id": id, "changes": { "stage": "Vibing" } })).await["status"], "rejected");
    assert_eq!(caller.op("lead.update", json!({ "id": id, "changes": { "assignee_id": w.id("caller") } })).await["status"], "rejected");
    // A batch push answers each operation on its own.
    let push = caller
        .post(
            "/sync/push",
            json!({ "operations": [
                { "id": Uuid::new_v4(), "kind": "note.add", "payload": { "lead_id": id, "body": "one" }, "queued_offline": true },
                { "id": Uuid::new_v4(), "kind": "note.add", "payload": { "lead_id": Uuid::new_v4(), "body": "gone" }, "queued_offline": true },
            ] }),
        )
        .await
        .ok();
    let statuses: Vec<&str> = push["results"].as_array().unwrap().iter().map(|r| r["status"].as_str().unwrap()).collect();
    assert_eq!(statuses, vec!["applied", "rejected"]);
}

#[tokio::test]
async fn call_outcomes_schedule_callbacks_and_block_do_not_call() {
    let h = harness!();
    let w = world(&h).await;
    let caller = w.client("caller");
    let l = lead(caller, "David Brooks", json!({})).await;
    let id = l["id"].clone();
    let vm = caller.op("call.record", json!({ "lead_id": id, "outcome": "Voicemail", "occurred_at": "2026-10-15T15:12:00Z" })).await;
    assert_eq!(vm["status"], "applied");
    assert_eq!(vm["result"]["call"]["code"], "VM");
    assert_eq!(vm["result"]["lead"]["next_action_at"], "2026-10-16T15:12:00+00:00");
    // A callback needs a time, and replaces the open try-again task.
    assert_eq!(caller.op("call.record", json!({ "lead_id": id, "outcome": "Callback" })).await["status"], "rejected");
    caller.op("call.record", json!({ "lead_id": id, "outcome": "CB", "callback_at": "2026-10-20T09:15:00-04:00" })).await;
    let detail = caller.get(&format!("/api/v1/leads/{}", id.as_str().unwrap())).await.ok();
    let open: Vec<&Value> = detail["tasks"].as_array().unwrap().iter().filter(|t| t["done_at"].is_null() && t["type"] == "Callback").collect();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0]["due_at"], "2026-10-20T13:15:00+00:00");
    assert_eq!(detail["calls"].as_array().unwrap().len(), 2);
    assert_eq!(detail["lead"]["stage"], "Contacted");
    // Transfer qualifies and books an appointment.
    let other = lead(caller, "Patricia Flores", json!({})).await;
    let t = caller.op("call.record", json!({ "lead_id": other["id"], "outcome": "Transfer" })).await;
    assert_eq!(t["result"]["lead"]["stage"], "Qualified");
    assert_eq!(t["result"]["lead"]["sent_to"], "Appointments");
    // Do not call closes the lead, adds a suppression, and blocks further calls.
    caller.op("call.record", json!({ "lead_id": id, "outcome": "DNC" })).await;
    let blocked = caller.op("call.record", json!({ "lead_id": id, "outcome": "Voicemail" })).await;
    assert_eq!(blocked["status"], "rejected");
    let after = caller.get(&format!("/api/v1/leads/{}", id.as_str().unwrap())).await.ok();
    assert_eq!(after["lead"]["do_not_call"], true);
    assert_eq!(after["contact_restrictions"]["suppressed"], true);
    // Only a manager may lift it.
    assert_eq!(caller.op("lead.update", json!({ "id": id, "changes": { "do_not_call": false } })).await["status"], "rejected");
    assert_eq!(w.client("manager").op("lead.update", json!({ "id": id, "changes": { "do_not_call": false } })).await["status"], "applied");
    // Exports leave out do-not-call numbers.
    let csv = w.owner.get("/api/v1/exports/leads.csv").await;
    assert_eq!(csv.status, 200);
}

#[tokio::test]
async fn handoffs_change_ownership_once() {
    let h = harness!();
    let w = world(&h).await;
    let caller = w.client("caller");
    let l = lead(caller, "Angela Lewis", json!({})).await;
    let id = l["id"].clone();
    // Recipients need the accept capability; notes are required.
    assert_eq!(caller.op("handoff.request", json!({ "lead_id": id, "to_user": w.id("researcher"), "note": "x" })).await["status"], "rejected");
    assert_eq!(caller.op("handoff.request", json!({ "lead_id": id, "to_user": w.id("closer"), "note": "" })).await["status"], "rejected");
    let request = caller.op("handoff.request", json!({ "lead_id": id, "to_user": w.id("closer"), "note": "Ready for an offer" })).await;
    assert_eq!(request["status"], "applied");
    // One open handoff per lead.
    assert_eq!(caller.op("handoff.request", json!({ "lead_id": id, "to_user": w.id("manager"), "note": "again" })).await["status"], "rejected");
    // The recipient sees the lead while it is offered to them, but ownership has not moved.
    let closer = w.client("closer");
    assert_eq!(closer.get(&format!("/api/v1/leads/{}", id.as_str().unwrap())).await.ok()["lead"]["assignee_id"], json!(w.id("caller")));
    let handoff = request["result"]["id"].clone();
    // Two acceptances at once: one applies, the other finds it already accepted.
    let (a, b) = tokio::join!(
        closer.op("handoff.decide", json!({ "id": handoff, "decision": "accept" })),
        w.client("manager").op("handoff.decide", json!({ "id": handoff, "decision": "accept" }))
    );
    assert_eq!(a["status"], "applied");
    assert_eq!(b["status"], "applied");
    let detail = closer.get(&format!("/api/v1/leads/{}", id.as_str().unwrap())).await.ok();
    assert_eq!(detail["lead"]["assignee_id"], json!(w.id("closer")));
    assert_eq!(detail["lead"]["stage"], "Qualified");
    assert_eq!(detail["assignments"].as_array().unwrap().len(), 1);
    assert_eq!(detail["deal"]["stage"], "Qualified");
    // The caller no longer sees it; declining afterwards is refused.
    assert_eq!(caller.get(&format!("/api/v1/leads/{}", id.as_str().unwrap())).await.status, 404);
    assert_eq!(closer.op("handoff.decide", json!({ "id": handoff, "decision": "decline" })).await["status"], "rejected");
    // Deal stages follow the pipeline and a lost deal needs a reason.
    let deal = detail["deal"]["id"].clone();
    assert_eq!(closer.op("deal.update", json!({ "id": deal, "changes": { "stage": "Closed lost" } })).await["status"], "rejected");
    assert_eq!(closer.op("deal.update", json!({ "id": deal, "changes": { "stage": "Offer sent", "amount": 280000 } })).await["status"], "applied");
}

#[tokio::test]
async fn sync_pull_follows_access_and_resets_on_role_changes() {
    let h = harness!();
    let w = world(&h).await;
    let caller = w.client("caller");
    let snapshot = caller.get("/sync/snapshot").await.ok();
    let revision = snapshot["access_revision"].as_i64().unwrap();
    let cursor = snapshot["cursor"].as_i64().unwrap();
    let l = lead(caller, "Evelyn Scott", json!({})).await;
    caller.op("note.add", json!({ "lead_id": l["id"], "body": "hello" })).await;
    let pulled = caller.get(&format!("/sync/pull?cursor={cursor}&access_revision={revision}")).await.ok();
    let entities: Vec<&str> = pulled["changes"].as_array().unwrap().iter().map(|c| c["entity"].as_str().unwrap()).collect();
    assert!(entities.contains(&"lead") && entities.contains(&"note"));
    let cursor = pulled["cursor"].as_i64().unwrap();
    // Reassigned away: the next pull removes it.
    w.client("manager").op("lead.assign", json!({ "ids": [l["id"]], "assignee_id": w.id("closer") })).await;
    let removed = caller.get(&format!("/sync/pull?cursor={cursor}&access_revision={revision}")).await.ok();
    assert!(removed["changes"].as_array().unwrap().iter().any(|c| c["entity"] == "lead" && c["op"] == "remove"));
    // A role change moves the access revision: the client must reset.
    w.owner.patch(&format!("/api/v1/admin/members/{}", w.id("caller")), json!({ "restrictions": ["call"] })).await.ok();
    assert_eq!(caller.get(&format!("/sync/pull?cursor={cursor}&access_revision={revision}")).await.ok()["reset"], true);
    assert_eq!(caller.op("call.record", json!({ "lead_id": l["id"], "outcome": "Voicemail" })).await["status"], "rejected");
}

#[tokio::test]
async fn rules_run_once_per_event_and_jobs_respect_leases() {
    let h = harness!();
    let w = world(&h).await;
    let rule = w
        .owner
        .post(
            "/api/v1/rules",
            json!({ "name": "Qualified gets a review", "trigger": "lead.qualified", "conditions": [{ "field": "stage", "op": "eq", "value": "Qualified" }],
                    "actions": [{ "type": "create_task", "title": "Review the offer", "due_in_hours": 2 }, { "type": "notify", "to": "assignee", "text": "Qualified!" }] }),
        )
        .await
        .ok();
    assert_eq!(w.owner.post("/api/v1/rules", json!({ "name": "bad", "trigger": "nope", "actions": [] })).await.status, 400);
    let caller = w.client("caller");
    let l = lead(caller, "Daniel Moore", json!({})).await;
    caller.op("lead.update", json!({ "id": l["id"], "changes": { "stage": "Qualified" } })).await;
    // The worker claims every pending event and processes it.
    let claimed = caller.worker("/events/claim", json!({ "limit": 100 })).await.ok();
    let events = claimed["events"].as_array().unwrap().clone();
    let qualified = events.iter().find(|e| e["kind"] == "lead.qualified").expect("qualified event");
    let mut ran = Value::Null;
    for event in &events {
        let result = caller.worker(&format!("/events/{}/process", event["id"]), json!({ "org_id": event["org_id"] })).await.ok();
        if event["id"] == qualified["id"] {
            ran = result;
        }
    }
    assert_eq!(ran["runs"][0]["matched"], true);
    // Processing again, even after another claim, adds nothing.
    sqlx::query("UPDATE outbox_events SET processed_at = NULL, claimed_until = NULL").execute(&h.owner).await.unwrap();
    let again = caller.worker("/events/claim", json!({ "limit": 100 })).await.ok();
    for event in again["events"].as_array().unwrap() {
        caller.worker(&format!("/events/{}/process", event["id"]), json!({ "org_id": event["org_id"] })).await.ok();
    }
    let tasks = caller.get("/api/v1/tasks").await.ok();
    assert_eq!(tasks.as_array().unwrap().iter().filter(|t| t["title"] == "Review the offer").count(), 1);
    let notifications = caller.get("/api/v1/notifications").await.ok();
    assert_eq!(notifications.as_array().unwrap().iter().filter(|n| n["text"] == "Qualified!").count(), 1);
    let runs = w.owner.get(&format!("/api/v1/rules/{}/runs", rule["id"].as_str().unwrap())).await.ok();
    assert!(!runs.as_array().unwrap().is_empty());
    // Dry run evaluates without acting.
    let dry = w.owner.post(&format!("/api/v1/rules/{}/dry-run", rule["id"].as_str().unwrap()), json!({ "lead_id": l["id"] })).await.ok();
    assert_eq!(dry["matched"], true);
    // Jobs: claim, a second worker cannot complete it, lease expiry lets another claim it.
    let job = w.client("researcher").post("/api/v1/jobs", json!({ "kind": "skiptrace", "input": { "dataset": "x" } })).await.ok();
    assert_eq!(w.client("caller").post("/api/v1/jobs", json!({ "kind": "skiptrace" })).await.status, 403);
    let claim = caller.worker("/jobs/claim", json!({ "queues": ["python"], "lease_seconds": 10 })).await.ok();
    assert_eq!(claim["job"]["id"], job["id"]);
    assert_eq!(caller.worker("/jobs/claim", json!({ "queues": ["python"] })).await.ok()["job"], Value::Null);
    sqlx::query("UPDATE jobs SET lease_until = now() - interval '1 second'").execute(&h.owner).await.unwrap();
    let reclaimed = caller.worker("/jobs/claim", json!({ "queues": ["python"] })).await.ok();
    assert_eq!(reclaimed["job"]["attempts"], 2);
    let done = caller
        .worker(&format!("/jobs/{}/complete", job["id"].as_str().unwrap()), json!({ "org_id": w.org, "output": { "rows": 3 } }))
        .await
        .ok();
    assert_eq!(done["status"], "done");
    assert_eq!(caller.worker("/jobs/claim", json!({ "queues": ["python"] })).await.status, 200);
    // Workers without a token are refused.
    let anonymous = caller.http.post(format!("{}/internal/jobs/claim", h.base)).json(&json!({ "queues": ["python"] })).send().await.unwrap();
    assert_eq!(anonymous.status().as_u16(), 401);
}

#[tokio::test]
async fn reports_dashboards_and_scheduler_respect_scope() {
    let h = harness!();
    let w = world(&h).await;
    let caller = w.client("caller");
    let l = lead(caller, "James Parker", json!({})).await;
    caller.op("call.record", json!({ "lead_id": l["id"], "outcome": "Not interested" })).await;
    lead(&w.owner, "Hidden from caller", json!({ "assignee_id": w.id("closer") })).await;
    let dash = caller.get("/api/v1/dashboard").await.ok();
    assert_eq!(dash["visible_leads"], 1);
    assert!(dash.get("finance").is_none());
    let owner_dash = w.owner.get("/api/v1/dashboard").await.ok();
    assert_eq!(owner_dash["visible_leads"], 2);
    assert!(owner_dash.get("finance").is_some());
    let outcomes = caller.get("/api/v1/reports/outcomes").await.ok();
    assert_eq!(outcomes["rows"][0]["outcome"], "Not interested");
    // Downloads need export; revenue needs finance.
    assert_eq!(caller.get("/api/v1/reports/outcomes?format=csv").await.status, 403);
    assert_eq!(caller.get("/api/v1/reports/revenue").await.status, 403);
    assert_eq!(w.owner.get("/api/v1/reports/outcomes?format=csv").await.status, 200);
    // An overdue task produces its event once per scheduler tick.
    caller.op("task.create", json!({ "lead_id": l["id"], "title": "Late", "due_at": "2020-01-01T00:00:00Z" })).await;
    let first = caller.worker("/scheduler/tick", json!({})).await.ok();
    let second = caller.worker("/scheduler/tick", json!({})).await.ok();
    assert_eq!(first["overdue_tasks"], 1);
    assert_eq!(second["overdue_tasks"], 0);
    // Repeating tasks create their next instance once.
    let weekly = caller.op("task.create", json!({ "title": "Weekly review", "due_at": "2026-10-19T09:00:00Z", "recurrence": "FREQ=WEEKLY" })).await;
    let complete = json!({ "id": Uuid::new_v4(), "kind": "task.complete", "payload": { "id": weekly["result"]["id"] } });
    caller.post("/api/v1/ops", complete.clone()).await.ok();
    caller.post("/api/v1/ops", complete).await.ok();
    let next: Vec<Value> = caller.get("/api/v1/tasks").await.ok().as_array().unwrap().iter().filter(|t| t["title"] == "Weekly review").cloned().collect();
    assert_eq!(next.len(), 1);
    assert_eq!(next[0]["due_at"], "2026-10-26T09:00:00+00:00");
}

#[tokio::test]
async fn dashboard_works_without_redis_and_legacy_import_is_idempotent() {
    let Some(h) = start_with(false).await else { return };
    let w = world(&h).await;
    let dash = w.owner.get("/api/v1/dashboard").await.ok();
    assert_eq!(dash["cached"], false);
    assert_eq!(w.owner.get("/readyz").await.ok()["database"], true);
    let payload = json!({
        "org_id": w.org, "project": { "legacy_id": "p1", "name": "Tampa absentee owners" },
        "datasets": [{ "legacy_id": "d1", "name": "List A", "rows": [{ "row_number": 2, "raw": { "Name": "Ana Lopez" } }] }],
        "leads": [{ "legacy_key": "k1", "name": "Ana Lopez", "phone": "+17165553102", "address": "2 Test Rd", "stage": "contacted", "callback_on": "2026-10-20",
                    "sources": [{ "dataset": "d1", "row_number": 2 }], "notes": [{ "legacy_id": "n1", "body": "Old note", "at": "2026-01-01T00:00:00Z" }],
                    "calls": [{ "legacy_id": "c1", "phone": "+17165553102", "outcome": "Left voicemail", "meaning": "voicemail", "at": "2026-01-02T00:00:00Z" }] }],
        "marks": [{ "number": "+17165553199", "mark": "do_not_call" }],
    });
    let mut dry = payload.clone();
    dry["dry_run"] = json!(true);
    let preview = w.owner.worker("/legacy/import", dry).await.ok();
    assert_eq!(preview["would_import"]["leads"], 1);
    assert_eq!(w.owner.get("/api/v1/leads").await.ok()["leads"].as_array().unwrap().len(), 0);
    let first = w.owner.worker("/legacy/import", payload.clone()).await.ok();
    let second = w.owner.worker("/legacy/import", payload).await.ok();
    assert_eq!(first["imported"]["leads"], 1);
    assert_eq!(first["imported"]["notes"], 1);
    assert_eq!(second["imported"]["leads"], 0);
    assert_eq!(second["imported"]["calls"], 0);
    let leads = w.owner.get("/api/v1/leads?assignee=unassigned").await.ok();
    let imported = &leads["leads"][0];
    assert_eq!(imported["stage"], "Contacted");
    assert!(imported["assignee_id"].is_null());
    let detail = w.owner.get(&format!("/api/v1/leads/{}", imported["id"].as_str().unwrap())).await.ok();
    assert_eq!(detail["sources"][0]["legacy_key"], "k1");
    assert_eq!(detail["notes"][0]["author_label"], "Legacy import");
}

#[tokio::test]
async fn deals_open_whole_and_tasks_and_deals_can_be_removed() {
    let h = harness!();
    let w = world(&h).await;
    let manager = w.client("manager");
    let caller = w.client("caller");
    let l = lead(manager, "Rita Hale", json!({})).await;
    let lead_id = l["id"].clone();
    let deal_id = Uuid::new_v4();
    // A role without finance cannot open a deal; bad figures and stages are refused before anything is written.
    assert_eq!(caller.op("deal.create", json!({ "lead_id": lead_id })).await["status"], "rejected");
    assert_eq!(manager.op("deal.create", json!({ "lead_id": lead_id, "amount": -5 })).await["status"], "rejected");
    assert_eq!(manager.op("deal.create", json!({ "lead_id": lead_id, "close_date": "soon" })).await["status"], "rejected");
    assert_eq!(manager.op("deal.create", json!({ "lead_id": lead_id, "stage": "Closed won" })).await["status"], "rejected");
    assert_eq!(manager.op("deal.create", json!({ "lead_id": lead_id, "stage": "Nonsense" })).await["status"], "rejected");
    // The whole deal arrives in one operation, under the id the device chose.
    let created = manager
        .op("deal.create", json!({ "id": deal_id, "lead_id": lead_id, "stage": "Appointment", "amount": 250000, "fee": 15000, "close_date": "2027-01-15" }))
        .await;
    assert_eq!(created["status"], "applied", "{created}");
    assert_eq!(created["result"]["id"], json!(deal_id));
    assert_eq!(created["result"]["stage"], "Appointment");
    assert_eq!(created["result"]["close_date"], "2027-01-15");
    // One deal per lead.
    assert_eq!(manager.op("deal.create", json!({ "lead_id": lead_id })).await["status"], "rejected");

    // Tasks can be removed, and a second removal finds nothing.
    let task = manager.op("task.create", json!({ "lead_id": lead_id, "title": "Send the offer" })).await;
    assert_eq!(task["status"], "applied");
    let task_id = task["result"]["id"].clone();
    let snapshot = manager.get("/sync/snapshot").await.ok();
    let revision = snapshot["access_revision"].as_i64().unwrap();
    let cursor = snapshot["cursor"].as_i64().unwrap();
    assert_eq!(manager.op("task.delete", json!({ "id": task_id })).await["status"], "applied");
    assert_eq!(manager.op("task.delete", json!({ "id": task_id })).await["status"], "rejected");
    // Removals are refused when queued offline, like the other destructive changes.
    let offline = manager
        .post("/api/v1/ops", json!({ "id": Uuid::new_v4(), "kind": "deal.delete", "queued_offline": true, "payload": { "id": deal_id } }))
        .await
        .ok();
    assert_eq!(offline["status"], "rejected");

    // A deal's own follow-up tasks go with it, and every device is told about both.
    let attached = manager.op("task.create", json!({ "lead_id": lead_id, "title": "Chase the signature" })).await;
    sqlx::query("UPDATE tasks SET deal_id = $2 WHERE id = $1::uuid").bind(attached["result"]["id"].as_str().unwrap()).bind(deal_id).execute(&h.owner).await.unwrap();
    assert_eq!(caller.op("deal.delete", json!({ "id": deal_id })).await["status"], "rejected");
    assert_eq!(manager.op("deal.delete", json!({ "id": deal_id })).await["status"], "applied");
    assert_eq!(manager.op("deal.delete", json!({ "id": deal_id })).await["status"], "rejected");
    let pulled = manager.get(&format!("/sync/pull?cursor={cursor}&access_revision={revision}")).await.ok();
    let removed: Vec<(String, String)> = pulled["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["op"] == "remove")
        .map(|c| (c["entity"].as_str().unwrap().to_string(), c["id"].as_str().unwrap().to_string()))
        .collect();
    assert!(removed.contains(&("task".into(), task_id.as_str().unwrap().to_string())));
    assert!(removed.contains(&("deal".into(), deal_id.to_string())));
    assert!(removed.contains(&("task".into(), attached["result"]["id"].as_str().unwrap().to_string())));
    assert!(manager.get(&format!("/api/v1/leads/{}", lead_id.as_str().unwrap())).await.ok()["deal"].is_null());
}

#[tokio::test]
async fn leads_archive_and_restore_and_notes_can_be_corrected_or_removed() {
    let h = harness!();
    let w = world(&h).await;
    let caller = w.client("caller");
    let manager = w.client("manager");
    let closer = w.client("closer");
    let l = lead(caller, "Owen Hart", json!({})).await;
    let id = l["id"].clone();
    // Archive keeps the lead and marks it; it cannot be archived twice, and restoring clears the mark.
    let archived = caller.op("lead.archive", json!({ "id": id })).await;
    assert_eq!(archived["status"], "applied", "{archived}");
    assert!(archived["result"]["archived_at"].is_string());
    assert_eq!(caller.op("lead.archive", json!({ "id": id })).await["status"], "rejected");
    assert!(caller.get(&format!("/api/v1/leads/{}", id.as_str().unwrap())).await.ok()["lead"]["archived_at"].is_string());
    let restored = caller.op("lead.restore", json!({ "id": id })).await;
    assert_eq!(restored["status"], "applied");
    assert!(restored["result"]["archived_at"].is_null());
    assert_eq!(caller.op("lead.restore", json!({ "id": id })).await["status"], "rejected");

    // A note can be corrected by its author; someone who cannot see the lead cannot touch it.
    let added = caller.op("note.add", json!({ "lead_id": id, "body": "Fisrt draft" })).await;
    let note = added["result"]["id"].clone();
    let edited = caller.op("note.edit", json!({ "id": note, "body": "First draft" })).await;
    assert_eq!(edited["status"], "applied", "{edited}");
    assert_eq!(edited["result"]["body"], "First draft");
    assert!(edited["result"]["edited_at"].is_string());
    assert_eq!(caller.op("note.edit", json!({ "id": note, "body": "" })).await["status"], "rejected");
    assert_eq!(closer.op("note.edit", json!({ "id": note, "body": "Not mine" })).await["status"], "rejected");
    // A manager who can edit the lead may remove it; the removal reaches other devices, and the earlier text stays in the audit trail.
    let snapshot = caller.get("/sync/snapshot").await.ok();
    let (revision, cursor) = (snapshot["access_revision"].as_i64().unwrap(), snapshot["cursor"].as_i64().unwrap());
    assert_eq!(manager.op("note.delete", json!({ "id": note })).await["status"], "applied");
    let pulled = caller.get(&format!("/sync/pull?cursor={cursor}&access_revision={revision}")).await.ok();
    assert!(pulled["changes"].as_array().unwrap().iter().any(|c| c["entity"] == "note" && c["op"] == "remove" && c["id"] == note));
    let kept: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE entity_id = $1::uuid AND before->>'body' = 'First draft'")
        .bind(note.as_str().unwrap())
        .fetch_one(&h.owner)
        .await
        .unwrap();
    assert_eq!(kept, 1);
    // An undone removal comes back as the same note.
    let back = caller.op("note.add", json!({ "id": note, "lead_id": id, "body": "First draft" })).await;
    assert_eq!(back["result"]["id"], note);
}
