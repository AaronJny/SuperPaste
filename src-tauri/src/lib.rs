mod clipboard;
mod commands;
mod focus;
mod models;
mod tray;

use clipboard::ClipboardWatcher;
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                                focus::restore_previous_app();
                            } else {
                                // 先保存当前活跃应用
                                focus::save_frontmost_app();

                                // 获取当前屏幕信息并设置位置（多显示器支持）
                                if let Some(screen) = focus::get_screen_at_mouse() {
                                    let scale = screen.scale_factor;

                                    // NSScreen 返回逻辑像素，Tauri 使用物理像素
                                    let phys_width = screen.width * scale;
                                    let phys_height = screen.height * scale;
                                    let phys_x = screen.x * scale;
                                    let phys_y = screen.y * scale;

                                    // 窗口宽度为屏幕的 92%，高度为屏幕的 45%
                                    let win_width = (phys_width * 0.92) as u32;
                                    let win_height = (phys_height * 0.45).max(350.0 * scale) as u32;

                                    let _ = window.set_size(tauri::PhysicalSize::new(win_width, win_height));

                                    // 获取主屏幕物理高度用于 Y 坐标转换
                                    let primary_phys_height = if let Ok(Some(pm)) = window.primary_monitor() {
                                        pm.size().height as f64
                                    } else {
                                        phys_height
                                    };

                                    // macOS Y 轴向上，Tauri Y 轴向下
                                    let screen_top_tauri = primary_phys_height - phys_y - phys_height;
                                    let x = phys_x + (phys_width - win_width as f64) / 2.0;
                                    let y = screen_top_tauri + phys_height - win_height as f64 - (80.0 * scale);

                                    let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
                                }

                                // 使用 Tauri 标准 API 显示窗口
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Hide from dock on macOS
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Create system tray
            tray::create_tray(app)?;

            // Start clipboard watcher
            let watcher = ClipboardWatcher::new();
            watcher.start(app.handle().clone());

            // Register global shortcut
            app.global_shortcut()
                .register("CommandOrControl+Shift+V")
                .expect("Failed to register shortcut");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::hide_window,
            commands::show_window,
            commands::copy_to_clipboard,
            commands::delete_image_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
