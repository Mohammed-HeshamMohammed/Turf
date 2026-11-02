// Standard-library-only request logging for the feature service scaffolds.
fn escaped(value: &str) -> String {
    let mut out = String::new();
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""), '\\' => out.push_str("\\\\"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}
pub fn record(method: &str, path: &str, status: u16, seconds: f64) {
    let path = path.split(['?', '#']).next().unwrap_or("/");
    if path == "/healthz" && status < 400 { return; }
    println!("{{\"cw_event\":\"request\",\"method\":\"{}\",\"path\":\"{}\",\"status\":{},\"duration_seconds\":{}}}", escaped(method), escaped(path), status, seconds);
}
