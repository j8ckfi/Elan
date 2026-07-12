#[cfg(target_os = "macos")]
mod glass;
mod host;
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
            host::init(app.handle());
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    glass::apply_sidebar_glass(&window);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pi::pi_start,
            pi::pi_send,
            pi::pi_stop,
            pi::pi_list_sessions,
            pi::pi_read_session,
            pi::pi_delete_session,
            pi::pi_rename_session
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                host::shutdown(app);
            }
        });
}
