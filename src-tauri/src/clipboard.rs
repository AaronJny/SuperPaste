use arboard::Clipboard;
use image::{imageops::FilterType, DynamicImage, ImageBuffer, Rgba};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use uuid::Uuid;

pub struct ClipboardWatcher {
    last_text_hash: Arc<Mutex<String>>,
    last_image_hash: Arc<Mutex<String>>,
}

impl ClipboardWatcher {
    pub fn new() -> Self {
        Self {
            last_text_hash: Arc::new(Mutex::new(String::new())),
            last_image_hash: Arc::new(Mutex::new(String::new())),
        }
    }

    pub fn start(&self, app: AppHandle) {
        let last_text_hash = self.last_text_hash.clone();
        let last_image_hash = self.last_image_hash.clone();

        thread::spawn(move || {
            let mut clipboard = match Clipboard::new() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Failed to create clipboard: {}", e);
                    return;
                }
            };

            loop {
                // Check for text
                if let Ok(text) = clipboard.get_text() {
                    if !text.is_empty() {
                        let hash = compute_hash(text.as_bytes());
                        let last_hash = last_text_hash.blocking_lock();
                        if hash != *last_hash {
                            drop(last_hash);
                            *last_text_hash.blocking_lock() = hash.clone();
                            let _ = app.emit(
                                "clipboard-text",
                                ClipboardPayload {
                                    content_type: "text".to_string(),
                                    content_hash: hash,
                                    text_content: Some(text),
                                    image_path: None,
                                    thumbnail_path: None,
                                    file_size: 0,
                                },
                            );
                        }
                    }
                }

                // Check for image
                if let Ok(img_data) = clipboard.get_image() {
                    let hash = compute_hash(&img_data.bytes);
                    let last_hash = last_image_hash.blocking_lock();
                    if hash != *last_hash {
                        drop(last_hash);

                        let file_size = img_data.bytes.len() as i64;
                        // Skip if > 10MB
                        if file_size <= 10 * 1024 * 1024 {
                            *last_image_hash.blocking_lock() = hash.clone();

                            // Save image
                            if let Ok((image_path, thumb_path)) = save_image(&app, &img_data) {
                                let _ = app.emit(
                                    "clipboard-image",
                                    ClipboardPayload {
                                        content_type: "image".to_string(),
                                        content_hash: hash,
                                        text_content: None,
                                        image_path: Some(image_path),
                                        thumbnail_path: Some(thumb_path),
                                        file_size,
                                    },
                                );
                            }
                        }
                    }
                }

                thread::sleep(Duration::from_millis(300));
            }
        });
    }
}

#[derive(Clone, serde::Serialize)]
pub struct ClipboardPayload {
    pub content_type: String,
    pub content_hash: String,
    pub text_content: Option<String>,
    pub image_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub file_size: i64,
}

pub fn compute_hash(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn save_image(app: &AppHandle, img_data: &arboard::ImageData) -> Result<(String, String), String> {
    let img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(
        img_data.width as u32,
        img_data.height as u32,
        img_data.bytes.to_vec(),
    )
    .ok_or("Failed to create image buffer")?;

    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let images_dir = app_dir.join("images");
    std::fs::create_dir_all(&images_dir).map_err(|e| e.to_string())?;

    let filename = format!("{}.png", Uuid::new_v4());
    let thumb_filename = format!("{}_thumb.png", Uuid::new_v4());

    let filepath = images_dir.join(&filename);
    let thumb_path = images_dir.join(&thumb_filename);

    // Save original
    DynamicImage::ImageRgba8(img.clone())
        .save(&filepath)
        .map_err(|e| e.to_string())?;

    // Generate and save thumbnail (200x200 max)
    let thumb = DynamicImage::ImageRgba8(img).resize(200, 200, FilterType::Lanczos3);
    thumb.save(&thumb_path).map_err(|e| e.to_string())?;

    Ok((
        filepath.to_string_lossy().to_string(),
        thumb_path.to_string_lossy().to_string(),
    ))
}
