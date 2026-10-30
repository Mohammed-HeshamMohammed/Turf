//! Google sign-in for the desktop app. Google does not allow signing in inside an embedded window, and the window must
//! never leave the app, so sign-in happens in the person's own browser:
//!
//! 1. `google_sign_in_listen` opens a listener on 127.0.0.1 (this computer only) at a free port.
//! 2. `open_in_browser` opens the auth service (services/auth), which sends the browser to Google.
//! 3. When Google is done, auth sends the browser to `http://127.0.0.1:<port>/callerwhale-sign-in?code=…` (or
//!    `?error=…`). The listener answers with a "return to Caller Whale" page and hands the one-time code to the window as the
//!    `callerwhale-sign-in` event; the window trades it for tokens at auth's /v1/oauth/exchange.

use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// A sign-in left unfinished this long is given up; the person can start again.
const WAIT_FOR: Duration = Duration::from_secs(300);

fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = (bytes[i] == b'%' && i + 2 < bytes.len())
            .then(|| std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()))
            .flatten();
        match (bytes[i], hex) {
            (b'+', _) => out.push(b' '),
            (b'%', Some(byte)) => {
                out.push(byte);
                i += 2;
            }
            (other, _) => out.push(other),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What the browser brought back to the listener.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Back {
    pub code: Option<String>,
    pub error: Option<String>,
    pub state: Option<String>,
}

/// `code`, `error` and `state` from a request line like `GET /callerwhale-sign-in?code=abc HTTP/1.1`, for requests to
/// `expected` only (None for /favicon.ico and the like).
pub fn parse(request_line: &str, expected: &str) -> Option<Back> {
    let target = request_line.split_whitespace().nth(1)?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != expected {
        return None;
    }
    let mut back = Back::default();
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key {
            "code" if !value.is_empty() => back.code = Some(decode(value)),
            "error" => back.error = Some(decode(value)),
            "state" => back.state = Some(decode(value)),
            _ => {}
        }
    }
    Some(back)
}

/// Waits for the browser to come back to `path` on this listener, answers it with a page, and returns what it
/// brought. None after WAIT_FOR.
fn wait(listener: TcpListener, path: &str) -> Option<Back> {
    let _ = listener.set_nonblocking(true);
    let started = Instant::now();
    while started.elapsed() < WAIT_FOR {
        let Ok((stream, _)) = listener.accept() else {
            std::thread::sleep(Duration::from_millis(200));
            continue;
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut reader = BufReader::new(&stream);
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            continue;
        }
        let mut stream = &stream;
        let Some(back) = parse(&line, path) else {
            // A browser also asks for /favicon.ico and the like: nothing there.
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue;
        };
        let body = if back.code.is_some() {
            page("You're signed in", "Return to the Caller Whale app. You can close this tab.")
        } else {
            page("Sign-in did not finish", "Return to the Caller Whale app and try again.")
        };
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        return Some(back);
    }
    None
}

const PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Caller Whale</title>\
<style>body{font-family:'Segoe UI',system-ui,sans-serif;background:#f1f1ef;color:#151515;display:grid;place-items:center;min-height:100vh;margin:0}\
main{background:#fff;border-radius:22px;padding:32px 36px;max-width:420px;text-align:center;box-shadow:0 1px 3px #0001}\
h1{font-size:22px;margin:0 0 8px}p{color:#595959;margin:0}</style></head><body><main><h1>TITLE</h1><p>TEXT</p></main></body></html>";

fn page(title: &str, text: &str) -> String {
    PAGE.replace("TITLE", title).replace("TEXT", text)
}

/// Starts waiting for the browser to come back, and answers the port to send it to.
#[tauri::command]
pub fn google_sign_in_listen(app: AppHandle) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Could not get ready for sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    std::thread::spawn(move || {
        let answer = match wait(listener, "/callerwhale-sign-in") {
            Some(back) => json!({ "code": back.code, "error": back.error }),
            None => json!({ "code": null, "error": "Sign-in took too long. Try again." }),
        };
        let _ = app.emit("callerwhale-sign-in", answer);
    });
    Ok(port)
}

/// Opens an address in the person's default browser. Only web addresses.
#[tauri::command]
pub fn open_in_browser(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) || url.chars().any(|c| c.is_whitespace() || c == '"') {
        return Err("Only web addresses can be opened".into());
    }
    #[cfg(windows)]
    let result = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();
    result.map(|_| ()).map_err(|e| format!("Could not open the browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_sign_in_path_counts() {
        let code = |c: &str| Back { code: Some(c.into()), ..Back::default() };
        assert_eq!(parse("GET /callerwhale-sign-in?code=a%2Bb HTTP/1.1", "/callerwhale-sign-in"), Some(code("a+b")));
        assert_eq!(parse("GET /callerwhale-sign-in?error=Sign-in+was+cancelled. HTTP/1.1", "/callerwhale-sign-in"), Some(Back { error: Some("Sign-in was cancelled.".into()), ..Back::default() }));
        assert_eq!(parse("GET /favicon.ico HTTP/1.1", "/callerwhale-sign-in"), None);
        assert_eq!(parse("GET /callerwhale-sign-in HTTP/1.1", "/callerwhale-sign-in"), Some(Back::default()));
    }

    #[test]
    fn only_web_addresses_open() {
        assert!(open_in_browser("file:///C:/Windows/system32/calc.exe".into()).is_err());
        assert!(open_in_browser("javascript:alert(1)".into()).is_err());
        assert!(open_in_browser("https://x.example/\" & calc".into()).is_err());
    }
}
