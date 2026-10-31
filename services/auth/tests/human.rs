mod common;
use common::*;
use callerwhale_auth::{config::Config, human::HumanCheck};
use axum::http::StatusCode;
use serde_json::json;

#[tokio::test]
async fn protection_blocks_before_firebase_even_with_a_supplied_code() {
    let fake = firebase::start().await;
    let mut config = Config::for_tests();
    config.firebase = Some(callerwhale_auth::firebase::Firebase::new("key", &fake.base, &fake.base));
    config.human = Some(HumanCheck::new("public-site", "private-secret", vec!["app.example".into()]).unwrap());
    let app = service_with(config).await;
    for code in [serde_json::Value::Null, json!(""), json!("123456")] {
        let (status, body) = call(&app, "POST", "/v1/sessions", Some(json!({"email":"person@example.com","password":PASSWORD,"code":code})), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["code"], "human_required");
    }
    let (status, _) = call(&app, "POST", "/v1/accounts", Some(json!({"email":"person@example.com","password":PASSWORD,"name":"Person"})), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(fake.world.lock().unwrap().calls.is_empty());
    let (_, body) = call(&app, "GET", "/v1/security", None, None).await;
    assert_eq!(body["bot_protection"]["site_key"], "public-site");
    assert!(!body.to_string().contains("private-secret"));
}

#[tokio::test]
async fn disabled_protection_is_a_noop_and_security_is_public() {
    let app = service().await;
    sign_up(&app, "person@example.com").await;
    let (status, body) = call(&app, "GET", "/v1/security", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["bot_protection"]["enabled"], false);
    assert_eq!(body["password_policy"]["minimum"], 8);
}

#[test]
fn enabled_configuration_requires_both_keys_and_hosts() {
    assert!(HumanCheck::new("", "secret", vec!["app.example".into()]).is_err());
    assert!(HumanCheck::new("site", "", vec!["app.example".into()]).is_err());
    assert!(HumanCheck::new("site", "secret", vec![]).is_err());
}
