mod pi;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            pi::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pi::pi_start,
            pi::pi_send,
            pi::pi_stop,
            pi::pi_list_sessions,
            pi::pi_delete_session,
            pi::pi_rename_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
