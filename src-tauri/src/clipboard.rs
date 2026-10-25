use crate::pending_queue::{PendingPayload, PendingQueue};
use arboard::Clipboard;
use image::{imageops::FilterType, DynamicImage, ImageBuffer, Rgba};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

const MAX_CAPTURE_BYTES: usize = 10 * 1024 * 1024;

#[derive(Default)]
struct PendingClipboard {
    queue: PendingQueue<ClipboardPayload>,
    last_text_hash: String,
    last_image_hash: String,
}

impl PendingClipboard {
    fn is_full(&self) -> bool {
        self.queue.is_full()
    }

    fn push(&mut self, payload: ClipboardPayload) {
        if payload.content_type == "text" {
            self.last_text_hash = payload.content_hash.clone();
        } else {
            self.last_image_hash = payload.content_hash.clone();
        }
        self.queue.push(payload);
    }

    fn acknowledge(&mut self, id: &str) {
        self.queue.acknowledge(id);
    }
}

#[derive(Clone, Default)]
pub struct ClipboardWatcher {
    pending: Arc<Mutex<PendingClipboard>>,
    status: Arc<Mutex<Option<String>>>,
}

impl ClipboardWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn pending(&self) -> Result<Vec<ClipboardPayload>, String> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| "Clipboard queue is unavailable")?;
        Ok(pending.queue.snapshot())
    }

    pub fn acknowledge(&self, id: &str) -> Result<(), String> {
        self.pending
            .lock()
            .map_err(|_| "Clipboard queue is unavailable")?
            .acknowledge(id);
        Ok(())
    }

    /// Capture holds this same mutex from before file creation through queue
    /// insertion, so the scanner cannot see an unprotected half-written pair.
    pub fn orphan_candidates(&self, images_dir: &Path) -> Result<Vec<PathBuf>, String> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| "Clipboard queue is unavailable")?;
        crate::image_files::orphan_candidates(images_dir, &protected_image_paths(&pending))
    }

    pub fn delete_images(
        &self,
        images_dir: &Path,
        paths: &[PathBuf],
        references: &[PathBuf],
    ) -> Result<(), String> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| "Clipboard queue is unavailable")?;
        let protected = protected_image_paths(&pending);
        if paths.iter().any(|path| protected.contains(path)) {
            return Err("Image is still awaiting persistence; cleanup will retry".into());
        }
        let mut all_references = references.to_vec();
        all_references.extend(protected);
        crate::image_files::delete_unreferenced_images(images_dir, paths, &all_references)
    }

    pub fn status(&self) -> Result<Option<String>, String> {
        Ok(self
            .status
            .lock()
            .map_err(|_| "Clipboard status is unavailable")?
            .clone())
    }

    fn report_status(&self, app: &AppHandle, message: Option<String>) {
        if let Ok(mut status) = self.status.lock() {
            if *status != message {
                if let Some(error) = &message {
                    eprintln!("{error}");
                }
                *status = message.clone();
                let _ = app.emit("clipboard-status", message);
            }
        }
    }

    pub fn start(&self, app: AppHandle) {
        let watcher = self.clone();
        let owner = app
            .state::<crate::image_files::ImageDirectoryOwner>()
            .inner()
            .clone();
        thread::spawn(move || {
            // Keep the OS lock for the entire capture-thread lifetime, even if
            // other application state begins shutting down first.
            let _owner = owner;
            // A transient clipboard initialization failure should not disable
            // capture for the rest of the application's lifetime.
            let mut clipboard = loop {
                match Clipboard::new() {
                    Ok(clipboard) => break clipboard,
                    Err(error) => {
                        watcher.report_status(
                            &app,
                            Some(format!("Cannot open clipboard; retrying: {error}")),
                        );
                        thread::sleep(Duration::from_secs(1));
                    }
                }
            };
            loop {
                let mut pending = match watcher.pending.lock() {
                    Ok(pending) => pending,
                    Err(_) => {
                        watcher.report_status(
                            &app,
                            Some("Clipboard capture stopped: queue unavailable".into()),
                        );
                        return;
                    }
                };
                if pending.is_full() {
                    // Never evict unacknowledged captures. Pause polling and
                    // tell the frontend instead of silently losing queued data.
                    drop(pending);
                    watcher.report_status(
                        &app,
                        Some("Clipboard capture paused until pending history is saved".into()),
                    );
                    thread::sleep(Duration::from_millis(300));
                    continue;
                }

                let mut captured = false;
                let mut capture_error = None;
                if let Ok(text) = clipboard.get_text() {
                    if text.len() > MAX_CAPTURE_BYTES {
                        capture_error = Some(
                            "Clipboard text exceeds the 10 MiB capture limit and was not saved"
                                .into(),
                        );
                    } else if !text.is_empty() {
                        let hash = compute_hash(text.as_bytes());
                        if hash != pending.last_text_hash {
                            pending.push(ClipboardPayload {
                                id: Uuid::new_v4().to_string(),
                                content_type: "text".into(),
                                content_hash: hash,
                                text_content: Some(text),
                                image_path: None,
                                thumbnail_path: None,
                                file_size: 0,
                            });
                            captured = true;
                        }
                    }
                }

                if !pending.is_full() {
                    if let Ok(image) = clipboard.get_image() {
                        if image.bytes.len() > MAX_CAPTURE_BYTES {
                            capture_error = Some("Clipboard image exceeds the 10 MiB capture limit and was not saved".into());
                        } else {
                            let hash = compute_hash(&image.bytes);
                            if hash != pending.last_image_hash {
                                // Do not advance the hash before both files have
                                // been saved and the payload is retained for retry.
                                match save_image(&app, &image) {
                                    Ok((image_path, thumbnail_path)) => {
                                        pending.push(ClipboardPayload {
                                            id: Uuid::new_v4().to_string(),
                                            content_type: "image".into(),
                                            content_hash: hash,
                                            text_content: None,
                                            image_path: Some(image_path),
                                            thumbnail_path: Some(thumbnail_path),
                                            file_size: image.bytes.len() as i64,
                                        });
                                        captured = true;
                                    }
                                    Err(error) => {
                                        capture_error =
                                            Some(format!("Image capture failed; retrying: {error}"))
                                    }
                                }
                            }
                        }
                    }
                }
                drop(pending);
                watcher.report_status(&app, capture_error);
                if captured {
                    // Events are wake-ups, not the data transport. Captures
                    // survive absent listeners and failed database operations.
                    let _ = app.emit("clipboard-available", ());
                }
                thread::sleep(Duration::from_millis(300));
            }
        });
    }
}

fn protected_image_paths(pending: &PendingClipboard) -> HashSet<PathBuf> {
    pending
        .queue
        .snapshot()
        .iter()
        .flat_map(|item| {
            [item.image_path.as_deref(), item.thumbnail_path.as_deref()]
                .into_iter()
                .flatten()
                .map(PathBuf::from)
        })
        .collect()
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ClipboardPayload {
    pub id: String,
    pub content_type: String,
    pub content_hash: String,
    pub text_content: Option<String>,
    pub image_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub file_size: i64,
}

impl PendingPayload for ClipboardPayload {
    fn id(&self) -> &str {
        &self.id
    }
    fn text_bytes(&self) -> usize {
        self.text_content.as_ref().map_or(0, String::len)
    }
}

pub fn compute_hash(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn save_image(app: &AppHandle, data: &arboard::ImageData<'_>) -> Result<(String, String), String> {
    let images_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("images");
    save_image_in(&images_dir, data)
}

fn save_image_in(
    images_dir: &Path,
    data: &arboard::ImageData<'_>,
) -> Result<(String, String), String> {
    let width = u32::try_from(data.width).map_err(|_| "Image width is too large")?;
    let height = u32::try_from(data.height).map_err(|_| "Image height is too large")?;
    let image: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(width, height, data.bytes.to_vec())
            .ok_or("Failed to create image buffer")?;
    std::fs::create_dir_all(images_dir).map_err(|e| e.to_string())?;
    let metadata = std::fs::symlink_metadata(images_dir).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Image directory must be a real directory, not a symlink".into());
    }
    let id = Uuid::new_v4();
    let filepath = images_dir.join(format!("{id}.png"));
    let thumbnail_path = images_dir.join(format!("{id}_thumb.png"));
    let result = save_image_pair(&filepath, &thumbnail_path, image);
    result.map(|()| {
        (
            filepath.to_string_lossy().into_owned(),
            thumbnail_path.to_string_lossy().into_owned(),
        )
    })
}

fn save_image_pair(
    filepath: &Path,
    thumbnail_path: &Path,
    image: ImageBuffer<Rgba<u8>, Vec<u8>>,
) -> Result<(), String> {
    crate::image_files::write_image_pair(filepath, thumbnail_path, || {
        let image = DynamicImage::ImageRgba8(image);
        image.save(filepath).map_err(|error| error.to_string())?;
        let thumbnail = image.resize(200, 200, FilterType::Lanczos3);
        thumbnail
            .save(thumbnail_path)
            .map_err(|error| error.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(id: &str) -> ClipboardPayload {
        ClipboardPayload {
            id: id.into(),
            content_type: "text".into(),
            content_hash: id.into(),
            text_content: Some("sample".into()),
            image_path: None,
            thumbnail_path: None,
            file_size: 0,
        }
    }

    #[test]
    fn reading_does_not_remove_pending_items_and_ack_is_idempotent() {
        let watcher = ClipboardWatcher::new();
        watcher.pending.lock().unwrap().push(payload("first"));
        watcher.pending.lock().unwrap().push(payload("second"));
        assert_eq!(watcher.pending().unwrap().len(), 2);
        assert_eq!(watcher.pending().unwrap().len(), 2);
        watcher.acknowledge("first").unwrap();
        watcher.acknowledge("first").unwrap();
        assert_eq!(watcher.pending().unwrap()[0].id, "second");
    }

    #[test]
    fn thumbnail_failure_removes_the_written_original() {
        let dir = std::env::temp_dir().join(format!("superpaste-save-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let original = dir.join("original.png");
        let thumbnail = dir.join("missing-parent").join("thumb.png");
        let image = ImageBuffer::from_pixel(2, 2, Rgba([0, 0, 0, 255]));
        assert!(save_image_pair(&original, &thumbnail, image).is_err());
        assert!(!original.exists());
        assert!(!thumbnail.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn scanner_waits_for_capture_to_publish_pending_paths_and_ack_releases_them() {
        let dir = std::env::temp_dir().join(format!("superpaste-race-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let original = dir.join(format!("{}.png", Uuid::new_v4()));
        let thumbnail = dir.join(format!("{}_thumb.png", Uuid::new_v4()));
        let watcher = ClipboardWatcher::new();
        let mut capture = watcher.pending.lock().unwrap();
        std::fs::write(&original, b"in-flight").unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let scanner = watcher.clone();
        let scan_dir = dir.clone();
        let thread = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            result_tx
                .send(scanner.orphan_candidates(&scan_dir))
                .unwrap();
        });
        started_rx.recv().unwrap();
        assert!(result_rx.recv_timeout(Duration::from_millis(30)).is_err());
        std::fs::write(&thumbnail, b"complete").unwrap();
        let mut image = payload("in-flight");
        image.content_type = "image".into();
        image.image_path = Some(original.to_string_lossy().into_owned());
        image.thumbnail_path = Some(thumbnail.to_string_lossy().into_owned());
        capture.push(image);
        drop(capture);
        assert!(result_rx.recv().unwrap().unwrap().is_empty());
        thread.join().unwrap();
        assert!(watcher
            .delete_images(&dir, &[original.clone()], &[])
            .is_err());
        assert!(original.exists());
        // JS is permitted to acknowledge only after a successful DB save.
        watcher.acknowledge("in-flight").unwrap();
        assert_eq!(watcher.orphan_candidates(&dir).unwrap().len(), 2);
        watcher
            .delete_images(&dir, &[original.clone()], &[original.clone()])
            .unwrap();
        assert!(original.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn fresh_process_recovers_files_left_before_pending_or_database_insertion() {
        let dir = std::env::temp_dir().join(format!("superpaste-crash-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let orphan = dir.join(format!("{}.png", Uuid::new_v4()));
        std::fs::write(&orphan, b"process-ended-before-enqueue").unwrap();
        let fresh_watcher = ClipboardWatcher::new();
        assert_eq!(
            fresh_watcher.orphan_candidates(&dir).unwrap(),
            vec![orphan.clone()]
        );
        fresh_watcher
            .delete_images(&dir, &[orphan.clone()], &[])
            .unwrap();
        assert!(!orphan.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
