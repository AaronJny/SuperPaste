export interface ClipboardItem {
  id: number;
  content_type: 'text' | 'image';
  content_hash: string;
  text_content: string | null;
  image_path: string | null;
  thumbnail_path: string | null;
  file_size: number;
  source_app: string | null;
  created_at: string;
  updated_at: string;
}

export interface Settings {
  shortcut: string;
  max_items: number;
  max_days: number;
  max_file_size_mb: number;
}
