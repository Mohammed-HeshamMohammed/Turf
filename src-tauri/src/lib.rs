mod mapcache;
mod sidecar;
mod store;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol(mapcache::SCHEME, mapcache::handle)
        .manage(sidecar::ServiceBridge::default())
        .manage(store::Store::default())
        .setup(|app| {
            // Packaged builds resolve the service from the bundle, never a source checkout.
            if let Ok(resources) = app.path().resource_dir() {
                if resources.join("service").is_dir() {
                    *app.state::<sidecar::ServiceBridge>().resources.lock().expect("bridge lock") = Some(resources);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar::service_call,
            store::turf_state,
            store::turf_set_mark,
            store::turf_set_area_columns,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Turf")
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
