// Generated from tools/runtime-log/access.rs.txt. Log metadata, never headers or bodies.
pub async fn record(request: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    let started = std::time::Instant::now();
    let path = request.uri().path().to_owned();
    let method = request.method().to_string();
    let response = next.run(request).await;
    let status = response.status().as_u16();
    if path != "/healthz" || status >= 400 {
        println!("{}", serde_json::json!({"cw_event":"request", "method":method, "path":path,
            "status":status, "duration_seconds":started.elapsed().as_secs_f64()}));
    }
    response
}
