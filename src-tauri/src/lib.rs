mod pi;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            pi::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pi::pi_start,
            pi::pi_send,
            pi::pi_stop,
            pi::pi_list_sessions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
