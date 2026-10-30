#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use seal_runtime::{error::Result, runtime::Runtime};
use std::sync::Arc;
use tauri::{Emitter, Manager};

#[tauri::command]
async fn native_call(
    runtime: tauri::State<'_, Runtime>,
    operation: String,
    args: serde_json::Value,
) -> Result<serde_json::Value> {
    runtime.call(&operation, args).await
}

fn main() {
    tauri::Builder::default()
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started
                && let Some(runtime) = webview.app_handle().try_state::<Runtime>() {
                runtime.close_all();
            }
        })
        .setup(|app| {
            let directory = if cfg!(debug_assertions) {
                std::env::var_os("SEALSHELL_DATA_DIR")
                    .map(std::path::PathBuf::from)
                    .unwrap_or(app.path().app_data_dir()?)
            } else {
                app.path().app_data_dir()?
            };
            let handle = app.handle().clone();
            app.manage(Runtime::new(
                &directory,
                Arc::new(move |event| {
                    let _ = handle.emit("native-event", event);
                }),
            )?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![native_call])
        .build(tauri::generate_context!())
        .expect("failed to build SealShell")
        .run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                handle.state::<Runtime>().close_all();
            }
        });
}
