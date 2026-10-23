//! Turf's Skip Tracing service (../../service, Python) as a managed child process speaking JSON lines on stdin/stdout,
//! the same bridge as Turf's own desktop host (src-tauri/src/sidecar.rs), cut down to the commands the CRM sends.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;

/// Long work runs as a job and answers at once; a service silent for this long is hung.
const ANSWER_WITHIN: Duration = Duration::from_secs(180);

/// The only commands the CRM's Skip Tracing page sends. Anything else (opening arbitrary folders, importing files by
/// path, deleting lists) stays out of reach of the window.
pub const ALLOWED: &[&str] = &[
    "health.check",
    "project.open_workspace",
    "dataset.import_content",
    "job.get",
    "job.cancel",
    "skiptrace.suggest",
    "skiptrace.statuses",
    "skiptrace.save_settings",
    "skiptrace.scan",
    "skiptrace.review",
    "skiptrace.apply",
    "skiptrace.model_status",
];

pub struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<std::io::Result<String>>,
    next_id: u64,
}

impl Sidecar {
    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }
}

#[derive(Default)]
pub struct ServiceBridge {
    pub process: Mutex<Option<Sidecar>>,
    /// Bundled resource directory in packaged builds; `None` in development.
    pub resources: Mutex<Option<PathBuf>>,
}

/// The service folder in development: `TURF_SERVICE_ROOT`, else `service/` at the repository root.
fn service_root() -> PathBuf {
    std::env::var_os("TURF_SERVICE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../service")))
}

fn service_executable(resources: &Path) -> PathBuf {
    resources.join("service").join(if cfg!(windows) { "turf-service.exe" } else { "turf-service" })
}

pub fn spawn(resources: Option<&Path>) -> Result<Sidecar, String> {
    let mut command = match resources.filter(|r| service_executable(r).is_file()) {
        Some(resources) => {
            let mut command = Command::new(service_executable(resources));
            command.arg("--resources").arg(resources).current_dir(resources);
            command
        }
        None => {
            let root = service_root().canonicalize().map_err(|e| format!("Turf's Skip Tracing service was not found: {e}"))?;
            let python = std::env::var("TURF_PYTHON").unwrap_or_else(|_| "python".into());
            let mut command = Command::new(python);
            command.args(["-m", "turf_service.server", "--resources"]).arg(&root).env("PYTHONPATH", &root).current_dir(&root);
            command
        }
    };
    command.env("PYTHONUTF8", "1").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| format!("Could not start the Skip Tracing engine: {e}. Install Python 3.11+ or set TURF_PYTHON."))?;
    let stdin = child.stdin.take().ok_or("service stdin unavailable")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("service stdout unavailable")?);
    let (sender, lines) = mpsc::channel();
    std::thread::spawn(move || {
        for line in stdout.lines() {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    Ok(Sidecar { child, stdin, lines, next_id: 0 })
}

pub fn is_allowed(command: &str) -> bool {
    ALLOWED.contains(&command)
}

fn roundtrip(sidecar: &mut Sidecar, command: &str, payload: &Value) -> Result<Value, String> {
    sidecar.next_id += 1;
    let request = json!({ "id": sidecar.next_id, "schema_version": 1, "command": command, "payload": payload });
    writeln!(sidecar.stdin, "{request}").map_err(|e| e.to_string())?;
    sidecar.stdin.flush().map_err(|e| e.to_string())?;
    let line = match sidecar.lines.recv_timeout(ANSWER_WITHIN) {
        Ok(line) => line.map_err(|e| e.to_string())?,
        Err(RecvTimeoutError::Timeout) => return Err("The Skip Tracing engine did not answer in time, so it was restarted. Try again.".into()),
        Err(RecvTimeoutError::Disconnected) => return Err("The Skip Tracing engine stopped unexpectedly".into()),
    };
    let response: Value = serde_json::from_str(&line).map_err(|e| format!("Invalid service response: {e}"))?;
    if response.get("id").and_then(Value::as_u64) != Some(sidecar.next_id) {
        return Err("Service response did not match the request".into());
    }
    Ok(response)
}

pub fn call(bridge: &ServiceBridge, command: &str, payload: Value) -> Result<Value, String> {
    if !is_allowed(command) {
        return Err("That command is not available to the CRM".into());
    }
    if !payload.is_object() {
        return Err("Command payload must be an object".into());
    }
    let resources = bridge.resources.lock().map_err(|_| "service bridge poisoned")?.clone();
    let mut guard = bridge.process.lock().map_err(|_| "service bridge poisoned")?;
    if guard.is_none() {
        *guard = Some(spawn(resources.as_deref())?);
    }
    let result = roundtrip(guard.as_mut().expect("sidecar present"), command, &payload);
    if result.is_err() {
        // Drop a broken process; the next call restarts it and durable job state is recovered from SQLite.
        if let Some(mut dead) = guard.take() {
            dead.kill();
        }
    }
    result
}

#[tauri::command(async)]
pub fn service_call(bridge: tauri::State<'_, ServiceBridge>, command: String, payload: Option<Value>) -> Result<Value, String> {
    call(&bridge, &command, payload.unwrap_or_else(|| json!({})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_skip_tracing_commands_pass() {
        assert!(is_allowed("skiptrace.scan"));
        assert!(is_allowed("project.open_workspace"));
        assert!(!is_allowed("project.open"));
        assert!(!is_allowed("dataset.import"));
        assert!(!is_allowed("dataset.delete"));
        assert!(!is_allowed("../etc.passwd"));
    }

    #[test]
    fn the_engine_answers_through_the_bridge() {
        let bridge = ServiceBridge::default();
        let answer = call(&bridge, "health.check", json!({})).expect("python service starts");
        assert_eq!(answer["ok"], json!(true));
        assert!(call(&bridge, "project.open", json!({ "path": "C:/" })).is_err());
        assert!(call(&bridge, "health.check", json!([])).is_err());
    }
}
