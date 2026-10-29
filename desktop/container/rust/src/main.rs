// No console window behind the app in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod downloads;
mod sidecar;
mod signin;

use tauri::{Manager, RunEvent};

/// Windows replaces the bundled engine too: release its executable before launching the installer.
#[tauri::command]
fn prepare_update(window: tauri::WebviewWindow, bridge: tauri::State<'_, sidecar::ServiceBridge>) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Updates can only be installed from the main window".into());
    }
    if let Some(mut process) = bridge.process.lock().map_err(|_| "The engine is busy")?.take() {
        process.kill();
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(sidecar::ServiceBridge::default())
        .setup(|app| {
            // Packaged builds resolve the service from the bundle, never a source checkout.
            if let Ok(resources) = app.path().resource_dir() {
                if resources.join("service").is_dir() {
                    *app.state::<sidecar::ServiceBridge>().resources.lock().expect("bridge lock") = Some(resources);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sidecar::service_call, signin::google_sign_in_listen, signin::google_sign_in, signin::open_in_browser, downloads::save_download, prepare_update])
        .build(tauri::generate_context!())
        .expect("error while building Turf Full CRM mode")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Ok(mut guard) = app.state::<sidecar::ServiceBridge>().process.lock() {
                    if let Some(mut process) = guard.take() {
                        process.kill();
                    }
                }
            }
        });
}
