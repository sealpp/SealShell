#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use seal_runtime::storage::Store;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            app.manage(Store::open(&directory.join("sealshell.sqlite"))?);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run SealShell");
}
