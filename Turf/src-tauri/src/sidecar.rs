//! Turf's application service (service/, Python) as a managed child process, speaking JSON lines on stdin/stdout.
//! The host forwards commands and contains no domain logic. The bridge follows DataForge's desktop host.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// How long the service may take to answer one command. Long work runs as a job and answers at once; what answers
/// directly (reading a page of rows, a map outline fetched with its own 60-second limit) is done well inside this.
/// A service that says nothing for this long is hung, and the window must not hang with it.
const ANSWER_WITHIN: Duration = Duration::from_secs(180);

pub struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    /// The service's answers, a line each, read on a thread of their own so that waiting for one can give up.
    lines: Receiver<std::io::Result<String>>,
    next_id: u64,
    /// When run from source: the service folder, when this process started, and when its files were last looked at.
    source: Option<PathBuf>,
    started: SystemTime,
    looked: Instant,
}

impl Sidecar {
    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }

    /// True when the service's code on disk is newer than this process. Only ever true when run from source:
    /// the window's screens reload by themselves when edited, and the service must not be left behind them.
    /// Looked at no more than every two seconds.
    fn is_outdated(&mut self) -> bool {
        let Some(root) = &self.source else { return false };
        if self.looked.elapsed() < Duration::from_secs(2) {
            return false;
        }
        self.looked = Instant::now();
        newest_source(root).is_some_and(|changed| changed > self.started)
    }
}

/// The latest change to any Python file of the service.
fn newest_source(root: &Path) -> Option<SystemTime> {
    ["turf_service", "turf_matching"]
        .iter()
        .filter_map(|package| std::fs::read_dir(root.join(package)).ok())
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|extension| extension == "py"))
        .filter_map(|entry| entry.metadata().and_then(|metadata| metadata.modified()).ok())
        .max()
}

#[derive(Default)]
pub struct ServiceBridge {
    pub process: Mutex<Option<Sidecar>>,
    /// Bundled resource directory in packaged builds; `None` in development.
    pub resources: Mutex<Option<PathBuf>>,
}

/// The service folder in development: `CALLERWHALE_SERVICE_ROOT`, else `service/` in this repository.
fn service_root() -> PathBuf {
    std::env::var_os("CALLERWHALE_SERVICE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../service")))
}

fn service_executable(resources: &Path) -> PathBuf {
    resources.join("service").join(if cfg!(windows) { "turf-service.exe" } else { "turf-service" })
}

pub fn spawn(resources: Option<&Path>) -> Result<Sidecar, String> {
    let mut source = None;
    let mut command = match resources.filter(|r| service_executable(r).is_file()) {
        Some(resources) => {
            // Packaged: the service built into one executable; no Python installation required.
            let mut command = Command::new(service_executable(resources));
            command.arg("--resources").arg(resources).current_dir(resources);
            command
        }
        None => {
            let root = service_root().canonicalize().map_err(|e| format!("Turf's service folder was not found: {e}"))?;
            let python = std::env::var("CALLERWHALE_PYTHON").unwrap_or_else(|_| "python".into());
            let mut command = Command::new(python);
            command
                .args(["-m", "turf_service.server", "--resources"])
                .arg(&root)
                .env("PYTHONPATH", &root)
                .current_dir(&root);
            source = Some(root);
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
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start Turf's service: {e}. Install Python 3.11+ or set CALLERWHALE_PYTHON."))?;
    let stdin = child.stdin.take().ok_or("service stdin unavailable")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("service stdout unavailable")?);
    let (sender, lines) = mpsc::channel();
    // Ends by itself when the service's output closes, or when nobody is waiting for its lines any more.
    std::thread::spawn(move || {
        for line in stdout.lines() {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    Ok(Sidecar { child, stdin, lines, next_id: 0, source, started: SystemTime::now(), looked: Instant::now() })
}

pub fn is_valid_command(command: &str) -> bool {
    let mut parts = command.split('.');
    let valid = |p: Option<&str>| p.is_some_and(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c == '_'));
    valid(parts.next()) && valid(parts.next()) && parts.next().is_none()
}

pub fn roundtrip(sidecar: &mut Sidecar, command: &str, payload: &Value) -> Result<Value, String> {
    roundtrip_within(sidecar, command, payload, ANSWER_WITHIN)
}

pub fn roundtrip_within(sidecar: &mut Sidecar, command: &str, payload: &Value, limit: Duration) -> Result<Value, String> {
    sidecar.next_id += 1;
    let request = json!({ "id": sidecar.next_id, "schema_version": 1, "command": command, "payload": payload });
    writeln!(sidecar.stdin, "{request}").map_err(|e| e.to_string())?;
    sidecar.stdin.flush().map_err(|e| e.to_string())?;
    let line = match sidecar.lines.recv_timeout(limit) {
        Ok(line) => line.map_err(|e| e.to_string())?,
        // The caller drops a service that failed, so the next command starts a fresh one.
        Err(RecvTimeoutError::Timeout) => {
            return Err(format!("Turf's service did not answer within {} seconds, so it was restarted. Try again.", limit.as_secs()))
        }
        Err(RecvTimeoutError::Disconnected) => return Err("Turf's service stopped unexpectedly".into()),
    };
    let response: Value = serde_json::from_str(&line).map_err(|e| format!("Invalid service response: {e}"))?;
    if response.get("id").and_then(Value::as_u64) != Some(sidecar.next_id) {
        return Err("Service response did not match the request".into());
    }
    Ok(response)
}

/// Sends one command, starting (or restarting) the sidecar as needed.
pub fn call(bridge: &ServiceBridge, command: &str, payload: Value) -> Result<Value, String> {
    if !is_valid_command(command) {
        return Err("Invalid command name".into());
    }
    if !payload.is_object() {
        return Err("Command payload must be an object".into());
    }
    let resources = bridge.resources.lock().map_err(|_| "service bridge poisoned")?.clone();
    let mut guard = bridge.process.lock().map_err(|_| "service bridge poisoned")?;
    // A service older than its own code is replaced before it is asked anything, except while a job is being
    // followed: the job lives in the process, and its progress is asked for with job.get.
    if command != "job.get" && guard.as_mut().is_some_and(Sidecar::is_outdated) {
        if let Some(mut old) = guard.take() {
            old.kill();
        }
    }
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
    fn command_names_are_validated() {
        assert!(is_valid_command("dataset.list"));
        assert!(is_valid_command("skiptrace.save_settings"));
        assert!(!is_valid_command("dataset"));
        assert!(!is_valid_command("dataset.list.extra"));
        assert!(!is_valid_command("Dataset.list"));
        assert!(!is_valid_command("../etc.passwd"));
    }

    #[test]
    fn a_service_older_than_its_code_is_noticed() {
        let mut sidecar = spawn(None).expect("python service starts");
        let long_ago = Instant::now() - Duration::from_secs(10);
        // Just started: nothing on disk is newer.
        sidecar.looked = long_ago;
        assert!(!sidecar.is_outdated());
        // As if it had been started before the code was last saved.
        sidecar.started = SystemTime::UNIX_EPOCH;
        sidecar.looked = long_ago;
        assert!(sidecar.is_outdated());
        // And it is not looked at again straight away.
        assert!(!sidecar.is_outdated());
        sidecar.kill();
    }

    #[test]
    fn a_service_that_does_not_answer_in_time_is_given_up_on() {
        let mut sidecar = spawn(None).expect("python service starts");
        // No time at all to answer: the wait gives up instead of holding the window.
        let error = roundtrip_within(&mut sidecar, "health.check", &json!({}), Duration::ZERO).expect_err("gives up");
        assert!(error.contains("did not answer"), "{error}");
        sidecar.kill();
    }

    #[test]
    fn sidecar_round_trips_a_health_check() {
        let mut sidecar = spawn(None).expect("python service starts");
        let response = roundtrip(&mut sidecar, "health.check", &json!({})).expect("round trip");
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["service"], "application");
        sidecar.kill();
    }
}
