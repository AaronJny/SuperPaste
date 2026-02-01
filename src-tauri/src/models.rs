use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardItem {
    pub id: i64,
    pub content_type: String, // "text" | "image"
    pub content_hash: String, // SHA256 hash for dedup
    pub text_content: Option<String>,
    pub image_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub file_size: i64,
    pub source_app: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub shortcut: String,
    pub max_items: i32,
    pub max_days: i32,
    pub max_file_size_mb: i32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            shortcut: "CommandOrControl+Shift+V".to_string(),
            max_items: 1000,
            max_days: 30,
            max_file_size_mb: 10,
        }
    }
}
