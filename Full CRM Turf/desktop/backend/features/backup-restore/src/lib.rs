//! Backup and restore (desktop backend module). Runs inside the desktop app and must work offline. The container's Tauri
//! commands call into this crate; nothing here opens a window, and nothing here needs the server to do its job.

/// The feature this module implements, as named in docs/features.
pub const FEATURE: &str = "backup-restore";

/// What the module can do today. Grows as real work moves in from src-tauri/ and the frontend.
pub fn status() -> &'static str {
    "scaffold"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_its_feature() {
        assert_eq!(FEATURE, "backup-restore");
    }

    #[test]
    fn starts_as_a_scaffold() {
        assert_eq!(status(), "scaffold");
    }
}
