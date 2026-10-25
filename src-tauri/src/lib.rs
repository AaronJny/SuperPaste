mod clipboard;
mod commands;
mod focus;
mod image_files;
mod models;
mod pending_queue;
mod shortcut_registration;
mod shortcuts;
mod tray;

use clipboard::ClipboardWatcher;
use shortcuts::ShortcutManager;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::ShortcutState;

#[derive(Default)]
struct PanelState {
    visible: AtomicBool,
}

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
#[cfg(target_os = "macos")]
fn calculate_window_geometry(window: &tauri::WebviewWindow) -> Option<(i32, i32, u32, u32)> {
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

/// All entry points use this path, on the main thread, so tray/commands/hotkeys
/// have the same focus bookkeeping and frontend reset event.
pub(crate) fn show_panel(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<PanelState>();
    if !state.visible.swap(true, Ordering::SeqCst) {
        focus::save_frontmost_app();
    }
    let result = (|| {
        let window = app
            .get_webview_window("main")
            .ok_or("Main window is unavailable")?;
        #[cfg(target_os = "macos")]
        {
            if let Some((x, y, width, height)) = calculate_window_geometry(&window) {
                window
                    .set_size(tauri::PhysicalSize::new(width, height))
                    .map_err(|e| e.to_string())?;
                window
                    .set_position(tauri::PhysicalPosition::new(x, y))
                    .map_err(|e| e.to_string())?;
            }
            let panel = app
                .get_webview_panel("main")
                .map_err(|e| format!("Panel unavailable: {e:?}"))?;
            panel.set_collection_behavior(
                CollectionBehavior::new()
                    .stationary()
                    .can_join_all_spaces()
                    .full_screen_auxiliary()
                    .into(),
            );
            panel.show_and_make_key();
        }
        #[cfg(not(target_os = "macos"))]
        {
            if let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? {
                let monitor_size = monitor.size();
                let monitor_position = monitor.position();
                let window_size = window.outer_size().map_err(|e| e.to_string())?;
                // Signed/saturating arithmetic also works when a display is
                // smaller than the panel (no unsigned subtraction underflow).
                let width_gap =
                    (i64::from(monitor_size.width) - i64::from(window_size.width)).max(0);
                let height_gap =
                    (i64::from(monitor_size.height) - i64::from(window_size.height) - 80).max(0);
                let x = i64::from(monitor_position.x) + width_gap / 2;
                let y = i64::from(monitor_position.y) + height_gap;
                window
                    .set_position(tauri::PhysicalPosition::new(x as i32, y as i32))
                    .map_err(|e| e.to_string())?;
            }
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
        }
        app.emit("panel-show", ()).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        state
            .visible
            .store(native_panel_is_visible(app), Ordering::SeqCst);
    }
    result
}

fn native_panel_is_visible(app: &tauri::AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        app.get_webview_panel("main")
            .map(|panel| panel.is_visible())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.get_webview_window("main")
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false)
    }
}

/// Blur is not a dismissal: the user already chose another application, so it
/// must not reactivate a stale target. Explicit dismissal/paste can restore it.
pub(crate) fn hide_panel(app: &tauri::AppHandle, restore_focus: bool) -> Result<(), String> {
    let state = app.state::<PanelState>();
    if !state.visible.swap(false, Ordering::SeqCst) {
        return Ok(());
    }
    let result = (|| {
        #[cfg(target_os = "macos")]
        {
            let panel = app
                .get_webview_panel("main")
                .map_err(|e| format!("Panel unavailable: {e:?}"))?;
            panel.hide();
            panel.set_collection_behavior(
                CollectionBehavior::new()
                    .stationary()
                    .move_to_active_space()
                    .full_screen_auxiliary()
                    .into(),
            );
        }
        #[cfg(not(target_os = "macos"))]
        app.get_webview_window("main")
            .ok_or("Main window is unavailable")?
            .hide()
            .map_err(|e| e.to_string())?;
        if restore_focus {
            focus::restore_previous_app();
        }
        Ok(())
    })();
    if result.is_err() {
        state
            .visible
            .store(native_panel_is_visible(app), Ordering::SeqCst);
    }
    result
}

fn handle_shortcut(app: &tauri::AppHandle) {
    let result = if app.state::<PanelState>().visible.load(Ordering::SeqCst) {
        hide_panel(app, true)
    } else {
        show_panel(app)
    };
    if let Err(error) = result {
        eprintln!("Cannot toggle clipboard panel: {error}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .manage(ClipboardWatcher::new())
        .manage(ShortcutManager::default())
        .manage(PanelState::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_sql::Builder::default().build());

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    builder
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed
                        && app.state::<ShortcutManager>().is_active(shortcut)
                    {
                        let handle = app.clone();
                        // Do not call back into shortcut registration while the
                        // plugin owns its event lock. UI work belongs on main.
                        if let Err(error) = app.run_on_main_thread(move || handle_shortcut(&handle))
                        {
                            eprintln!("Cannot schedule shortcut action: {error}");
                        }
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
                    let panel = window.to_panel::<SuperPastePanel>()?;

                    // Set panel level to dock (above most windows)
                    panel.set_level(PanelLevel::Dock.value());

                    // Set style mask for non-activating panel
                    panel.set_style_mask(
                        StyleMask::empty().resizable().nonactivating_panel().into(),
                    );

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
                        // Never steal focus back after the user changes apps.
                        if let Err(error) = hide_panel(&app_handle, false) {
                            eprintln!("Cannot hide clipboard panel on blur: {error}");
                        }
                    });

                    panel.set_event_handler(Some(handler.as_ref()));
                }
            }

            // Create system tray
            tray::create_tray(app)?;

            // Start clipboard watcher
            app.state::<ClipboardWatcher>().start(app.handle().clone());

            // The frontend restores the SQLite-backed shortcut through the
            // same authoritative command. A conflict must not crash the app;
            // the tray remains usable so the user can select another shortcut.
            if let Err(error) = app
                .state::<ShortcutManager>()
                .set(app.handle(), "CommandOrControl+Shift+V")
            {
                eprintln!("Cannot register initial shortcut: {error}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::hide_window,
            commands::hide_window_on_blur,
            commands::show_window,
            commands::copy_to_clipboard,
            commands::delete_image_files,
            commands::paste,
            commands::pending_clipboard,
            commands::acknowledge_clipboard,
            commands::clipboard_status,
            shortcuts::set_shortcut,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
