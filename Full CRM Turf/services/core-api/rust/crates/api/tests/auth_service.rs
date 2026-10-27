//! Signing in with the auth service (services/auth), the one source of truth for who someone is. The API checks
//! the token with auth's public keys and never calls auth. A person auth vouches for is known here from their first
//! request; their workspace (a trial organization, or an invitation) is this API's. Runs against real PostgreSQL like
//! the other end-to-end tests, and skips itself without TEST_DATABASE_URL.

mod common;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use common::*;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{json, Value};
use turf_auth_verify::{Claims, AUDIENCE, ISSUER};
use uuid::Uuid;

struct AuthKey {
    pkcs8: Vec<u8>,
    jwks: String,
}

fn auth_key() -> AuthKey {
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap().as_ref().to_vec();
    let public = Ed25519KeyPair::from_pkcs8(&pkcs8).unwrap().public_key().as_ref().to_vec();
    let jwks = json!({ "keys": [{ "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": "test", "x": URL_SAFE_NO_PAD.encode(public) }] });
    AuthKey { pkcs8, jwks: jwks.to_string() }
}

/// A token as the auth service would sign it.
fn token_with(key: &AuthKey, sub: &str, email: &str, name: &str, mfa: bool, email_verified: bool) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let claims = Claims { sub: sub.into(), email: email.into(), name: name.into(), sid: "s-1".into(), mfa, email_verified, iss: ISSUER.into(), aud: AUDIENCE.into(), iat: now, exp: now + 600 };
    let mut header = Header::new(Algorithm::EdDSA);
    header.kid = Some("test".into());
    encode(&header, &claims, &EncodingKey::from_ed_der(&key.pkcs8)).unwrap()
}

fn token(key: &AuthKey, sub: &str, email: &str, mfa: bool) -> String {
    token_with(key, sub, email, "From auth", mfa, true)
}

async fn send(base: &str, method: &str, path: &str, bearer: &str, org: Option<&str>, body: Option<Value>) -> (u16, Value) {
    let client = reqwest::Client::new();
    let url = format!("{base}{path}");
    let mut req = if method == "POST" { client.post(url).json(&body.unwrap_or_else(|| json!({}))) } else { client.get(url) };
    req = req.bearer_auth(bearer);
    if let Some(org) = org {
        req = req.header("x-turf-org", org);
    }
    let res = req.send().await.unwrap();
    (res.status().as_u16(), res.json().await.unwrap_or_default())
}

async fn get(base: &str, path: &str, bearer: &str, org: Option<&str>) -> (u16, Value) {
    send(base, "GET", path, bearer, org, None).await
}

#[tokio::test]
async fn an_auth_token_opens_the_api_for_the_same_person() {
    let key = auth_key();
    let Some(h) = start_with_auth(&key.jwks).await else { return };
    let w = world(&h).await;
    let caller = w.id("caller");
    let t = token(&key, &caller, "caller@example.com", false);

    // Without an organization the person is known, with no organization open.
    let (status, me) = get(&h.base, "/api/v1/me", &t, None).await;
    assert_eq!(status, 200, "{me}");
    assert_eq!(me["user"]["id"], caller.as_str());
    assert!(me["organization_id"].is_null());

    // With x-turf-org, their roles in that organization apply, exactly as with a session of this server.
    let (status, me) = get(&h.base, "/api/v1/me", &t, Some(&w.org)).await;
    assert_eq!(status, 200, "{me}");
    assert_eq!(me["organization_id"], w.org.as_str());
    assert_eq!(me["roles"], json!(["caller"]));
    assert_eq!(get(&h.base, "/api/v1/leads", &t, Some(&w.org)).await.0, 200);
}

#[tokio::test]
async fn auth_tokens_are_refused_when_they_should_be() {
    let key = auth_key();
    let Some(h) = start_with_auth(&key.jwks).await else { return };
    let w = world(&h).await;

    // A token signed by some other key.
    let other = auth_key();
    assert_eq!(get(&h.base, "/api/v1/me", &token(&other, &w.id("caller"), "caller@example.com", false), None).await.0, 401);

    // An organization the person is not in opens nothing.
    let t = token(&key, &w.id("caller"), "caller@example.com", false);
    let (status, me) = get(&h.base, "/api/v1/me", &t, Some(&Uuid::new_v4().to_string())).await;
    assert_eq!(status, 200);
    assert!(me["organization_id"].is_null());
    assert_eq!(get(&h.base, "/api/v1/me", &t, Some("not-an-id")).await.0, 400);

    // An account disabled here stays refused, whatever auth says.
    sqlx::query("UPDATE users SET disabled_at = now() WHERE email = 'caller@example.com'").execute(&h.owner).await.unwrap();
    assert_eq!(get(&h.base, "/api/v1/me", &t, None).await.0, 401);
}

#[tokio::test]
async fn the_api_still_accepts_its_own_sessions_alongside_auth_tokens() {
    let key = auth_key();
    let Some(h) = start_with_auth(&key.jwks).await else { return };
    let w = world(&h).await;
    assert_eq!(w.client("caller").get("/api/v1/me").await.status, 200);
}

#[tokio::test]
async fn a_person_auth_vouches_for_is_known_here_from_their_first_request() {
    let key = auth_key();
    let Some(h) = start_with_auth(&key.jwks).await else { return };
    let id = Uuid::new_v4().to_string();

    // Signed up at auth, email not confirmed yet.
    let (status, me) = get(&h.base, "/api/v1/me", &token_with(&key, &id, "New.Person@Example.com", "New Person", false, false), None).await;
    assert_eq!(status, 200, "{me}");
    assert_eq!(me["user"], json!({ "id": id, "email": "new.person@example.com", "name": "New Person" }));
    assert_eq!(me["organizations"], json!([]));
    let verified: bool = sqlx::query_scalar("SELECT email_verified_at IS NOT NULL FROM users WHERE id = $1::uuid").bind(&id).fetch_one(&h.owner).await.unwrap();
    assert!(!verified);

    // Once auth says the email is confirmed, this server records it (checkout needs it).
    assert_eq!(get(&h.base, "/api/v1/me", &token_with(&key, &id, "new.person@example.com", "New Person", false, true), None).await.0, 200);
    let verified: bool = sqlx::query_scalar("SELECT email_verified_at IS NOT NULL FROM users WHERE id = $1::uuid").bind(&id).fetch_one(&h.owner).await.unwrap();
    assert!(verified);

    // This server never checks a password for them: the copy here has none that works.
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1::uuid").bind(&id).fetch_one(&h.owner).await.unwrap();
    assert_eq!(hash, "!external-sign-in");
}

#[tokio::test]
async fn an_email_already_used_here_by_another_account_is_not_merged() {
    let key = auth_key();
    let Some(h) = start_with_auth(&key.jwks).await else { return };
    let _w = world(&h).await;
    let imposter = token(&key, &Uuid::new_v4().to_string(), "caller@example.com", false);
    assert_eq!(get(&h.base, "/api/v1/me", &imposter, None).await.0, 409);
}

#[tokio::test]
async fn a_new_person_opens_their_trial_workspace_here() {
    let key = auth_key();
    let Some(h) = start_with_auth(&key.jwks).await else { return };
    let t = token(&key, &Uuid::new_v4().to_string(), "founder@example.com", false);

    let (status, trial) = send(&h.base, "POST", "/api/v1/organizations/trial", &t, None, Some(json!({ "organization": "Founder Homes" }))).await;
    assert_eq!(status, 200, "{trial}");
    assert_eq!(trial["plan"], "trial");
    let org = trial["organization_id"].as_str().unwrap().to_string();

    let (_, me) = get(&h.base, "/api/v1/me", &t, Some(&org)).await;
    assert_eq!(me["roles"], json!(["owner", "admin"]));
    assert_eq!(me["subscription"]["status"], "trialing");
    assert_eq!(me["organizations"][0]["name"], "Founder Homes");

    // One trial per person.
    assert_eq!(send(&h.base, "POST", "/api/v1/organizations/trial", &t, None, None).await.0, 409);
}

#[tokio::test]
async fn an_invited_person_joins_with_their_auth_account() {
    let key = auth_key();
    let Some(h) = start_with_auth(&key.jwks).await else { return };
    let w = world(&h).await;
    let invite = w.owner.post("/api/v1/admin/members", json!({ "email": "newbie@example.com", "roles": ["caller"], "team_ids": [w.team] })).await.ok();
    let invitation = invite["token"].as_str().unwrap().to_string();

    // Someone signed in as a different email cannot use it, and it stays usable.
    let stranger = token(&key, &Uuid::new_v4().to_string(), "someone@example.com", false);
    assert_eq!(send(&h.base, "POST", "/api/v1/invitations/join", &stranger, None, Some(json!({ "token": invitation }))).await.0, 403);

    let newbie = token(&key, &Uuid::new_v4().to_string(), "Newbie@Example.com", false);
    let (status, joined) = send(&h.base, "POST", "/api/v1/invitations/join", &newbie, None, Some(json!({ "token": invitation }))).await;
    assert_eq!(status, 200, "{joined}");
    assert_eq!(joined["organization_id"], w.org.as_str());
    assert_eq!(get(&h.base, "/api/v1/me", &newbie, Some(&w.org)).await.1["roles"], json!(["caller"]));

    // An invitation works once.
    assert_eq!(send(&h.base, "POST", "/api/v1/invitations/join", &newbie, None, Some(json!({ "token": invitation }))).await.0, 403);
}

#[tokio::test]
async fn the_live_events_socket_takes_the_token_in_its_protocols() {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue};
    let key = auth_key();
    let Some(h) = start_with_auth(&key.jwks).await else { return };
    let w = world(&h).await;
    let t = token(&key, &w.id("caller"), "caller@example.com", false);
    let url = h.base.replace("http://", "ws://") + "/events";

    let mut request = url.as_str().into_client_request().unwrap();
    let protocols = format!("turf.v1, bearer.{t}, org.{}", w.org);
    request.headers_mut().insert("sec-websocket-protocol", HeaderValue::from_str(&protocols).unwrap());
    let (mut socket, response) = tokio_tungstenite::connect_async(request).await.expect("the socket opens");
    assert_eq!(response.headers().get("sec-websocket-protocol").unwrap(), "turf.v1");
    let hello = socket.next().await.unwrap().unwrap().into_text().unwrap();
    assert!(hello.contains("\"hello\""), "{hello}");

    // Without a valid token there is no socket.
    let mut refused = url.as_str().into_client_request().unwrap();
    refused.headers_mut().insert("sec-websocket-protocol", HeaderValue::from_static("turf.v1, bearer.a.b.c"));
    assert!(tokio_tungstenite::connect_async(refused).await.is_err());

    // The website finds the auth service here.
    let (status, service) = get(&h.base, "/api/v1/auth/service", &t, None).await;
    assert_eq!((status, service), (200, json!({ "url": "http://auth.example" })));
}
