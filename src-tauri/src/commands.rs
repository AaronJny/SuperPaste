use tauri::Manager;
use crate::models::Settings;
use crate::focus;
use std::fs;

#[tauri::command]
pub async fn get_settings() -> Result<Settings, String> {
    Ok(Settings::default())
}

#[tauri::command]
pub async fn save_settings(settings: Settings) -> Result<(), String> {
    println!("Saving settings: {:?}", settings);
    Ok(())
}

#[tauri::command]
pub async fn hide_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
        // 恢复之前应用的焦点
        focus::restore_previous_app();
    }
    Ok(())
}

#[tauri::command]
pub async fn show_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        position_window_bottom(&app);
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn copy_to_clipboard(content: String, content_type: String) -> Result<(), String> {
    use arboard::Clipboard;
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    
    match content_type.as_str() {
        "text" => {
            clipboard.set_text(&content).map_err(|e| e.to_string())?;
        }
        "image" => {
            // Load image from path and set to clipboard
            let img = image::open(&content).map_err(|e| e.to_string())?;
            let rgba = img.to_rgba8();
            let (width, height) = rgba.dimensions();
            let img_data = arboard::ImageData {
                width: width as usize,
                height: height as usize,
                bytes: rgba.into_raw().into(),
            };
            clipboard.set_image(img_data).map_err(|e| e.to_string())?;
        }
        _ => return Err("Unsupported content type".to_string()),
    }
    
    Ok(())
}

fn position_window_bottom(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(Some(monitor)) = window.current_monitor() {
            let monitor_size = monitor.size();
            let monitor_pos = monitor.position();
            
            if let Ok(window_size) = window.outer_size() {
                let x = monitor_pos.x + ((monitor_size.width - window_size.width) / 2) as i32;
                let y = monitor_pos.y + (monitor_size.height - window_size.height - 100) as i32;
                
                let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            }
        }
    }
}

#[tauri::command]
pub async fn delete_image_files(
    image_path: Option<String>,
    thumbnail_path: Option<String>,
) -> Result<(), String> {
    // 删除原图
    if let Some(path) = image_path {
        if !path.is_empty() {
            let _ = fs::remove_file(&path);
        }
    }
    
    // 删除缩略图
    if let Some(path) = thumbnail_path {
        if !path.is_empty() {
            let _ = fs::remove_file(&path);
        }
    }
    
    Ok(())
}
