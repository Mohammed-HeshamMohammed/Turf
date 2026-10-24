//! Files the window exports (CSV of a list, a check, a report). A desktop window has no browser download bar, so the
//! file is written to the person's Downloads folder, under a name that never overwrites another, and shown in the
//! file manager.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// A file name safe on every system: no folders, no reserved characters, never empty.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() { "turf-export.csv".into() } else { trimmed.chars().take(150).collect() }
}

/// `name.csv`, else `name (2).csv`, `name (3).csv`… in `folder`.
pub fn free_path(folder: &Path, name: &str) -> PathBuf {
    let first = folder.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) => (stem.to_string(), format!(".{extension}")),
        None => (name.to_string(), String::new()),
    };
    (2..10_000).map(|n| folder.join(format!("{stem} ({n}){extension}"))).find(|path| !path.exists()).unwrap_or(first)
}

#[tauri::command]
pub fn save_download(app: AppHandle, filename: String, contents: String) -> Result<String, String> {
    let folder = app.path().download_dir().map_err(|e| format!("The Downloads folder was not found: {e}"))?;
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let path = free_path(&folder, &safe_name(&filename));
    std::fs::write(&path, contents.as_bytes()).map_err(|e| format!("The file could not be saved: {e}"))?;
    // Show it, selected, in the file manager.
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg("-R").arg(&path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(&folder).spawn();
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_safe_and_never_overwrite() {
        assert_eq!(safe_name("..\\..\\evil:name?.csv"), "_.._evil_name_.csv");
        assert_eq!(safe_name("   "), "turf-export.csv");
        let folder = std::env::temp_dir().join(format!("turf-downloads-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let first = free_path(&folder, "check.csv");
        std::fs::write(&first, "a").unwrap();
        assert_eq!(free_path(&folder, "check.csv").file_name().unwrap(), "check (2).csv");
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
