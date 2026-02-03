mod clipboard;
mod commands;
mod focus;
mod models;
mod tray;

use clipboard::ClipboardWatcher;
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg(target_os = "macos")]
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask,
    WebviewWindowExt as NSPanelWindowExt,
};

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(SuperPastePanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true,
            can_become_main_window: false
        }
    })

    panel_event!(SuperPastePanelEventHandler {
        window_did_become_key(notification: &NSNotification) -> (),
        window_did_resign_key(notification: &NSNotification) -> (),
    })
}

/// 计算窗口位置和大小
fn calculate_window_geometry(window: &tauri::WebviewWindow) -> Option<(i32, i32, u32, u32)> {
    #[cfg(target_os = "macos")]
    {
        let screen = focus::get_screen_at_mouse()?;
        let scale = screen.scale_factor;

        let phys_width = screen.width * scale;
        let phys_height = screen.height * scale;
        let phys_x = screen.x * scale;
        let phys_y = screen.y * scale;

        let win_width = (phys_width * 0.92) as u32;
        let win_height = (phys_height * 0.45).max(350.0 * scale) as u32;

        let primary_phys_height = if let Ok(Some(pm)) = window.primary_monitor() {
            pm.size().height as f64
        } else {
            phys_height
        };

        let screen_top_tauri = primary_phys_height - phys_y - phys_height;
        let x = phys_x + (phys_width - win_width as f64) / 2.0;
        let y = screen_top_tauri + phys_height - win_height as f64 - (80.0 * scale);

        Some((x as i32, y as i32, win_width, win_height))
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Windows/Linux: 使用默认居中
        None
    }
}

/// macOS: 使用 NSPanel 显示窗口
#[cfg(target_os = "macos")]
fn show_panel(app: &tauri::AppHandle) {
    focus::save_frontmost_app();

    if let Some(window) = app.get_webview_window("main") {
        if let Some((x, y, w, h)) = calculate_window_geometry(&window) {
            let _ = window.set_size(tauri::PhysicalSize::new(w, h));
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }

    if let Ok(panel) = app.get_webview_panel("main") {
        panel.set_collection_behavior(
            CollectionBehavior::new()
                .stationary()
                .can_join_all_spaces()
                .full_screen_auxiliary()
                .into(),
        );
        panel.show_and_make_key();
    }
}

/// macOS: 使用 NSPanel 隐藏窗口
#[cfg(target_os = "macos")]
fn hide_panel(app: &tauri::AppHandle) {
    if let Ok(panel) = app.get_webview_panel("main") {
        panel.hide();
        panel.set_collection_behavior(
            CollectionBehavior::new()
                .stationary()
                .move_to_active_space()
                .full_screen_auxiliary()
                .into(),
        );
    }
    focus::restore_previous_app();
}

/// macOS: 检查面板是否可见
#[cfg(target_os = "macos")]
fn is_panel_visible(app: &tauri::AppHandle) -> bool {
    if let Ok(panel) = app.get_webview_panel("main") {
        panel.is_visible()
    } else {
        false
    }
}

/// 处理快捷键
fn handle_shortcut(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if is_panel_visible(app) {
            hide_panel(app);
        } else {
            show_panel(app);
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(window) = app.get_webview_window("main") {
            if window.is_visible().unwrap_or(false) {
                let _ = window.hide();
                focus::restore_previous_app();
            } else {
                focus::save_frontmost_app();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_sql::Builder::default().build());

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    builder
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        handle_shortcut(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Hide from dock on macOS
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Convert window to NSPanel on macOS with event handlers
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let panel = window.to_panel::<SuperPastePanel>().unwrap();

                    // Set panel level to dock (above most windows)
                    panel.set_level(PanelLevel::Dock.value());

                    // Set style mask for non-activating panel
                    panel.set_style_mask(StyleMask::empty().resizable().nonactivating_panel().into());

                    // Set initial collection behavior
                    panel.set_collection_behavior(
                        CollectionBehavior::new()
                            .stationary()
                            .move_to_active_space()
                            .full_screen_auxiliary()
                            .into(),
                    );

                    // Setup event handler for blur detection
                    let handler = SuperPastePanelEventHandler::new();
                    let app_handle = app.handle().clone();

                    handler.window_did_resign_key(move |_| {
                        // When panel loses key window status, hide it
                        hide_panel(&app_handle);
                    });

                    panel.set_event_handler(Some(handler.as_ref()));
                }
            }

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
