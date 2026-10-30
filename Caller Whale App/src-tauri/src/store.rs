//! What Caller Whale itself keeps: marks made by hand and the area columns picked for each list.
//! One JSON file in the app's data folder, written whole on every change.

use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

const MARKS: &[&str] = &["called", "wrong_number", "do_not_call", "interested"];
const LEVELS: &[&str] = &["state", "city", "zip"];

#[derive(Default)]
pub struct Store(Mutex<Option<Value>>);

fn file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("callerwhale.json"))
}

/// Reads the file. A missing file is the normal first run; one that cannot be read is an error, not a reason to start over.
fn load(app: &tauri::AppHandle) -> Result<Value, String> {
    let path = file(app)?;
    match fs::read_to_string(&path) {
        Ok(text) => {
            let mut state: Value = serde_json::from_str(&text).map_err(|e| format!("{} is damaged: {e}", path.display()))?;
            for key in ["marks", "areas"] {
                if !state[key].is_object() {
                    state[key] = json!({});
                }
            }
            Ok(state)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({ "marks": {}, "areas": {} })),
        Err(error) => Err(format!("Could not read {}: {error}", path.display())),
    }
}

/// Runs `change` on the saved state (loading it on first use) and, when `write` is set, saves the result.
/// Saved beside the file and renamed, so a crash cannot leave half a file.
fn with_state(app: &tauri::AppHandle, store: &Store, write: bool, change: impl FnOnce(&mut Value)) -> Result<Value, String> {
    let mut guard = store.0.lock().map_err(|_| "store poisoned")?;
    if guard.is_none() {
        *guard = Some(load(app)?);
    }
    let state = guard.as_mut().expect("state loaded");
    change(state);
    if write {
        let path = file(app)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, serde_json::to_string_pretty(state).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
    }
    Ok(state.clone())
}

#[tauri::command]
pub fn callerwhale_state(app: tauri::AppHandle, store: tauri::State<'_, Store>) -> Result<Value, String> {
    with_state(&app, &store, false, |_| {})
}

/// A mark belongs to a phone number, so it shows on every row and list with that number. No mark removes it.
#[tauri::command]
pub fn callerwhale_set_mark(app: tauri::AppHandle, store: tauri::State<'_, Store>, number: String, mark: Option<String>, at: String) -> Result<Value, String> {
    let digits = number.strip_prefix('+').unwrap_or("");
    if !(6..=15).contains(&digits.len()) || !digits.chars().all(|c| c.is_ascii_digit()) {
        return Err("A mark needs a phone number in international format".into());
    }
    if let Some(mark) = &mark {
        if !MARKS.contains(&mark.as_str()) {
            return Err(format!("Unknown mark: {mark}"));
        }
    }
    let state = with_state(&app, &store, true, |state| {
        let marks = state["marks"].as_object_mut().expect("marks is an object");
        match mark {
            Some(mark) => marks.insert(number, json!({ "mark": mark, "at": at })),
            None => marks.remove(&number),
        };
    })?;
    Ok(state["marks"].clone())
}

#[tauri::command]
pub fn callerwhale_set_area_columns(app: tauri::AppHandle, store: tauri::State<'_, Store>, dataset_id: String, mapping: Map<String, Value>) -> Result<Value, String> {
    if dataset_id.is_empty() {
        return Err("Area columns need a list id".into());
    }
    let kept: Map<String, Value> = mapping.into_iter().filter(|(level, column)| LEVELS.contains(&level.as_str()) && column.is_string()).collect();
    let state = with_state(&app, &store, true, |state| {
        state["areas"].as_object_mut().expect("areas is an object").insert(dataset_id, Value::Object(kept));
    })?;
    Ok(state["areas"].clone())
}
