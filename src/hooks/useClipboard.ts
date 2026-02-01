import { useEffect, useState, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import Database from '@tauri-apps/plugin-sql';
import type { ClipboardItem } from '../types';

const DB_NAME = 'sqlite:super-paste.db';

interface ClipboardPayload {
  content_type: string;
  content_hash: string;
  text_content: string | null;
  image_path: string | null;
  thumbnail_path: string | null;
  file_size: number;
}

export function useClipboard() {
  const [items, setItems] = useState<ClipboardItem[]>([]);
  const [db, setDb] = useState<Awaited<ReturnType<typeof Database.load>> | null>(null);

  // Initialize database
  useEffect(() => {
    async function initDb() {
      const database = await Database.load(DB_NAME);
      
      await database.execute(`
        CREATE TABLE IF NOT EXISTS clipboard_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content_type TEXT NOT NULL,
          content_hash TEXT NOT NULL UNIQUE,
          text_content TEXT,
          image_path TEXT,
          thumbnail_path TEXT,
          file_size INTEGER DEFAULT 0,
          source_app TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);

      await database.execute(`
        CREATE INDEX IF NOT EXISTS idx_updated_at ON clipboard_items(updated_at DESC)
      `);

      setDb(database);
      await loadItems(database);
    }

    initDb();
  }, []);

  const loadItems = async (database: Awaited<ReturnType<typeof Database.load>>) => {
    const result = await database.select<ClipboardItem[]>(
      'SELECT * FROM clipboard_items ORDER BY updated_at DESC LIMIT 100'
    );
    setItems(result);
  };

  // Listen for clipboard changes
  useEffect(() => {
    if (!db) return;

    const unlistenText = listen<ClipboardPayload>('clipboard-text', async (event) => {
      await saveItem(event.payload);
    });

    const unlistenImage = listen<ClipboardPayload>('clipboard-image', async (event) => {
      await saveItem(event.payload);
    });

    return () => {
      unlistenText.then(fn => fn());
      unlistenImage.then(fn => fn());
    };
  }, [db]);

  const saveItem = async (payload: ClipboardPayload) => {
    if (!db) return;

    // Check if exists (dedup by hash)
    const existing = await db.select<ClipboardItem[]>(
      'SELECT id FROM clipboard_items WHERE content_hash = ?',
      [payload.content_hash]
    );

    if (existing.length > 0) {
      // Update timestamp only
      await db.execute(
        "UPDATE clipboard_items SET updated_at = datetime('now') WHERE content_hash = ?",
        [payload.content_hash]
      );
    } else {
      // Insert new
      await db.execute(
        `INSERT INTO clipboard_items (content_type, content_hash, text_content, image_path, thumbnail_path, file_size)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          payload.content_type,
          payload.content_hash,
          payload.text_content,
          payload.image_path,
          payload.thumbnail_path,
          payload.file_size,
        ]
      );
    }

    // Cleanup old items (keep max 1000)
    await db.execute(`
      DELETE FROM clipboard_items WHERE id NOT IN (
        SELECT id FROM clipboard_items ORDER BY updated_at DESC LIMIT 1000
      )
    `);

    // Cleanup items older than 30 days
    await db.execute(`
      DELETE FROM clipboard_items WHERE updated_at < datetime('now', '-30 days')
    `);

    await loadItems(db);
  };

  const updateItemTime = useCallback(async (hash: string) => {
    if (!db) return;
    await db.execute(
      "UPDATE clipboard_items SET updated_at = datetime('now') WHERE content_hash = ?",
      [hash]
    );
    await loadItems(db);
  }, [db]);

  const searchItems = useCallback(async (query: string) => {
    if (!db) return;
    if (!query.trim()) {
      await loadItems(db);
      return;
    }
    const result = await db.select<ClipboardItem[]>(
      `SELECT * FROM clipboard_items 
       WHERE text_content LIKE ? 
       ORDER BY updated_at DESC LIMIT 100`,
      [`%${query}%`]
    );
    setItems(result);
  }, [db]);

  const deleteItem = useCallback(async (item: ClipboardItem) => {
    if (!db) return;
    
    // 删除图片文件（如果存在）
    if (item.image_path || item.thumbnail_path) {
      try {
        await invoke('delete_image_files', {
          imagePath: item.image_path,
          thumbnailPath: item.thumbnail_path,
        });
      } catch (e) {
        console.error('Failed to delete image files:', e);
      }
    }
    
    // 从数据库删除记录
    await db.execute('DELETE FROM clipboard_items WHERE id = ?', [item.id]);
    await loadItems(db);
  }, [db]);

  return { items, updateItemTime, searchItems, deleteItem };
}
