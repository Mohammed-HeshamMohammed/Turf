//! The street map's background, kept on this computer as it is used.
//!
//! The window asks this host for every piece of the map (the style, the tiles, the letter shapes and icons) instead
//! of asking OpenFreeMap directly. Each piece is fetched once, saved in the app's cache folder, and served from there
//! afterwards. Without a connection, every part of the map that was looked at before still draws.
//!
//! Only the address of a map piece is ever sent out: which part of the world, at which zoom. No list data.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::http::{Request, Response};
use tauri::{Manager, UriSchemeContext, UriSchemeResponder};

pub const SCHEME: &str = "mapcache";
const UPSTREAM: &str = "https://tiles.openfreemap.org";

/// Tiles, letter shapes and icons never change under the same address, so the saved copy is always used. The style
/// and the tile index do change, so they are fetched fresh when there is a connection and read from disk when not.
fn is_permanent(path: &str) -> bool {
    [".pbf", ".png", ".jpg", ".jpeg", ".webp", ".mvt"].iter().any(|ending| path.ends_with(ending))
}

fn content_type(path: &str) -> &'static str {
    if path.ends_with(".pbf") || path.ends_with(".mvt") {
        "application/x-protobuf"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else {
        "application/json"
    }
}

/// Where a map piece is saved. `None` for an address that is not a plain path, which is refused.
fn cache_file(root: &Path, path: &str) -> Option<PathBuf> {
    let mut file = root.to_path_buf();
    for part in path.split('/').filter(|part| !part.is_empty()) {
        // Letter-shape addresses hold "%20" and commas; anything else unusual is not a map piece.
        if part == "." || part == ".." || !part.chars().all(|c| c.is_ascii_alphanumeric() || "._-%,{}".contains(c)) {
            return None;
        }
        file.push(part);
    }
    if file == root {
        return None;
    }
    // Addresses with no file ending (the style, the tile index) would collide with the folders of the same name.
    if !path.rsplit('/').next().is_some_and(|name| name.contains('.')) {
        file.set_extension("json");
    }
    Some(file)
}

fn fetch(path: &str) -> Result<Vec<u8>, String> {
    let response = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(20))
        .build()
        .get(&format!("{UPSTREAM}{path}"))
        .call()
        .map_err(|error| error.to_string())?;
    let mut body = Vec::new();
    std::io::Read::read_to_end(&mut response.into_reader(), &mut body).map_err(|error| error.to_string())?;
    Ok(body)
}

fn save(file: &Path, body: &[u8]) {
    // A piece that cannot be saved is still shown; it is only fetched again next time.
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let temporary = file.with_extension("part");
    if fs::write(&temporary, body).is_ok() {
        let _ = fs::rename(&temporary, file);
    }
}

/// One map piece: from disk, from OpenFreeMap, or neither.
fn load(root: &Path, path: &str) -> Option<Vec<u8>> {
    let file = cache_file(root, path)?;
    if is_permanent(path) {
        if let Ok(body) = fs::read(&file) {
            return Some(body);
        }
    }
    match fetch(path) {
        Ok(body) => {
            save(&file, &body);
            Some(body)
        }
        Err(_) => fs::read(&file).ok(),
    }
}

fn respond(status: u16, path: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", content_type(path))
        // The window's pages are on another address than this scheme, so they must be told they may read it.
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .expect("a valid response")
}

pub fn handle<R: tauri::Runtime>(context: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let Ok(cache) = context.app_handle().path().app_cache_dir() else {
        return responder.respond(respond(500, "", Vec::new()));
    };
    let root = cache.join("map");
    let path = request.uri().path().to_string();
    // This scheme's own address as the window has to write it, which is not what the request reports: on Windows the
    // webview reaches a custom scheme through an ordinary http address.
    let own = if cfg!(windows) { format!("http://{SCHEME}.localhost") } else { format!("{SCHEME}://localhost") };
    // Fetching can take seconds; the window must not wait on it.
    std::thread::spawn(move || {
        let response = match load(&root, &path) {
            Some(body) if is_permanent(&path) => respond(200, &path, body),
            // The style and the tile index name OpenFreeMap's address for everything else; they are pointed back here.
            Some(body) => respond(200, &path, String::from_utf8_lossy(&body).replace(UPSTREAM, &own).into_bytes()),
            None => respond(504, &path, Vec::new()),
        };
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_pieces_are_saved_under_their_own_path_and_nothing_else_is() {
        let root = Path::new("cache");
        assert_eq!(cache_file(root, "/planet/20260101_001001_pt/5/7/13.pbf"), Some(root.join("planet").join("20260101_001001_pt").join("5").join("7").join("13.pbf")));
        assert_eq!(cache_file(root, "/fonts/Noto%20Sans%20Bold/0-255.pbf"), Some(root.join("fonts").join("Noto%20Sans%20Bold").join("0-255.pbf")));
        // The style and the tile index have no ending of their own, and "planet" is also a folder.
        assert_eq!(cache_file(root, "/styles/positron"), Some(root.join("styles").join("positron.json")));
        assert_eq!(cache_file(root, "/planet"), Some(root.join("planet.json")));
        assert_eq!(cache_file(root, "/../secrets"), None);
        assert_eq!(cache_file(root, "/a/..\\b"), None);
        assert_eq!(cache_file(root, "/"), None);
    }

    #[test]
    fn only_pieces_that_never_change_are_served_from_disk_first() {
        assert!(is_permanent("/planet/20260101/5/7/13.pbf"));
        assert!(is_permanent("/sprites/ofm_f384/ofm.png"));
        assert!(!is_permanent("/styles/positron"));
        assert!(!is_permanent("/planet"));
        assert!(!is_permanent("/sprites/ofm_f384/ofm.json"));
    }
}
