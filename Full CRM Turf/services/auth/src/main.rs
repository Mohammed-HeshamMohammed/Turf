//! Authentication service. Scaffold: it answers /healthz and /version. Swap the hand-written server for the project's web framework
//! when the first real route is added.
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

const SERVICE: &str = "auth";
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The status and JSON body for a request.
fn route(method: &str, path: &str) -> (u16, String) {
    match (method, path) {
        ("GET", "/healthz") => (200, format!(r#"{{"ok":true,"service":"{SERVICE}"}}"#)),
        ("GET", "/version") => (200, format!(r#"{{"service":"{SERVICE}","version":"{VERSION}"}}"#)),
        _ => (404, r#"{"error":"Not found."}"#.to_string()),
    }
}

fn handle(mut stream: TcpStream) {
    let mut buf = [0u8; 2048];
    let n = stream.read(&mut buf).unwrap_or(0);
    let request = String::from_utf8_lossy(&buf[..n]);
    let mut parts = request.lines().next().unwrap_or("").split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let (status, body) = route(method, path);
    let reason = if status == 200 { "OK" } else { "Not Found" };
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
}

fn main() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8101".to_string());
    let listener = TcpListener::bind(format!("0.0.0.0:{port}")).expect("could not bind the port");
    println!("{SERVICE} listening on http://localhost:{port}");
    for stream in listener.incoming().flatten() {
        handle(stream);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_names_the_service() {
        let (status, body) = route("GET", "/healthz");
        assert_eq!(status, 200);
        assert!(body.contains(r#""service":"auth""#));
    }

    #[test]
    fn version_is_reported() {
        let (status, body) = route("GET", "/version");
        assert_eq!(status, 200);
        assert!(body.contains(r#""version":"0.1.0""#));
    }

    #[test]
    fn unknown_paths_are_not_found() {
        assert_eq!(route("GET", "/nope").0, 404);
        assert_eq!(route("POST", "/healthz").0, 404);
    }
}
