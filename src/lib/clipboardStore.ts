import type { ClipboardItem, Settings } from '../types';

export interface ClipboardPayload {
  id: string;
  content_type: 'text' | 'image';
  content_hash: string;
  text_content: string | null;
  image_path: string | null;
  thumbnail_path: string | null;
  file_size: number;
}

export interface ClipboardDatabase {
  execute(query: string, values?: unknown[]): Promise<unknown>;
  select<T>(query: string, values?: unknown[]): Promise<T>;
}

type RemoveImages = (paths: string[], references: string[]) => Promise<void>;

// This store is called through one serialized queue by useClipboard. The trigger
// durably records file cleanup in the same SQLite statement that removes a row.
export class ClipboardStore {
  constructor(private db: ClipboardDatabase, private removeImages: RemoveImages) {}

  async initialize() {
    await this.db.execute(`CREATE TABLE IF NOT EXISTS clipboard_items (
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
    )`);
    await this.db.execute('CREATE INDEX IF NOT EXISTS idx_updated_at ON clipboard_items(updated_at DESC)');
    await this.db.execute('CREATE TABLE IF NOT EXISTS pending_file_deletions (path TEXT PRIMARY KEY NOT NULL)');
    await this.db.execute(`CREATE TABLE IF NOT EXISTS clipboard_deliveries (
      id TEXT PRIMARY KEY NOT NULL,
      content_type TEXT, content_hash TEXT, text_content TEXT,
      image_path TEXT, thumbnail_path TEXT, file_size INTEGER
    )`);
    await this.db.execute(`CREATE TRIGGER IF NOT EXISTS clipboard_delivery_received
      AFTER INSERT ON clipboard_deliveries BEGIN
        INSERT INTO clipboard_items
          (content_type, content_hash, text_content, image_path, thumbnail_path, file_size, updated_at)
          VALUES (NEW.content_type, NEW.content_hash, NEW.text_content, NEW.image_path,
            NEW.thumbnail_path, NEW.file_size, strftime('%Y-%m-%d %H:%M:%f', 'now'))
          ON CONFLICT(content_hash) DO UPDATE SET updated_at = excluded.updated_at;
        INSERT OR IGNORE INTO pending_file_deletions(path)
          SELECT NEW.image_path WHERE NEW.image_path IS NOT NULL AND NEW.image_path != ''
            AND NOT EXISTS (SELECT 1 FROM clipboard_items
              WHERE image_path = NEW.image_path OR thumbnail_path = NEW.image_path);
        INSERT OR IGNORE INTO pending_file_deletions(path)
          SELECT NEW.thumbnail_path WHERE NEW.thumbnail_path IS NOT NULL AND NEW.thumbnail_path != ''
            AND NOT EXISTS (SELECT 1 FROM clipboard_items
              WHERE image_path = NEW.thumbnail_path OR thumbnail_path = NEW.thumbnail_path);
        -- Retain only the opaque ID, never a second copy of deleted clipboard data.
        UPDATE clipboard_deliveries SET content_type = NULL, content_hash = NULL,
          text_content = NULL, image_path = NULL, thumbnail_path = NULL, file_size = NULL
          WHERE id = NEW.id;
      END`);
    await this.db.execute(`CREATE TRIGGER IF NOT EXISTS clipboard_images_after_delete
      AFTER DELETE ON clipboard_items BEGIN
        INSERT OR IGNORE INTO pending_file_deletions(path)
          SELECT OLD.image_path WHERE OLD.image_path IS NOT NULL AND OLD.image_path != '';
        INSERT OR IGNORE INTO pending_file_deletions(path)
          SELECT OLD.thumbnail_path WHERE OLD.thumbnail_path IS NOT NULL AND OLD.thumbnail_path != '';
      END`);
  }

  async save(payload: ClipboardPayload) {
    // The receipt and its insert trigger commit together. If acknowledgment is
    // lost, replay must not resurrect history the user deleted in the meantime.
    await this.db.execute(`INSERT OR IGNORE INTO clipboard_deliveries
      (id, content_type, content_hash, text_content, image_path, thumbnail_path, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [payload.id, payload.content_type, payload.content_hash, payload.text_content,
        payload.image_path, payload.thumbnail_path, payload.file_size]);
  }

  async acknowledge(id: string) {
    await this.db.execute('DELETE FROM clipboard_deliveries WHERE id = ?', [id]);
  }

  async reconcileDeliveries(pendingIds: string[]) {
    // A fresh Rust snapshot proves that absent IDs have already been consumed
    // (including an acknowledgment whose response was lost), or a prior process
    // ended. Keep receipts for every payload which can still be replayed.
    if (pendingIds.length === 0) {
      await this.db.execute('DELETE FROM clipboard_deliveries');
    } else {
      await this.db.execute(`DELETE FROM clipboard_deliveries WHERE id NOT IN (${pendingIds.map(() => '?').join(',')})`, pendingIds);
    }
  }

  async cleanup(settings: Settings) {
    // Invalid settings must not silently fall back to a shorter retention period.
    if (!Number.isInteger(settings.max_items) || settings.max_items < 100 || settings.max_items > 5000 ||
        !Number.isInteger(settings.max_days) || settings.max_days < 1 || settings.max_days > 365) {
      throw new Error('Invalid clipboard retention settings');
    }
    await this.db.execute(`DELETE FROM clipboard_items WHERE
      updated_at < datetime('now', ?) OR id NOT IN (
        SELECT id FROM clipboard_items ORDER BY updated_at DESC, id DESC LIMIT ?
      )`, [`-${settings.max_days} days`, settings.max_items]);
  }

  async queueOrphanCandidates(paths: string[]) {
    // Called in the same serialized queue as save/delete, AFTER Rust has taken
    // its capture-locked file snapshot. Never pass a pre-scan reference snapshot.
    for (const path of paths) {
      await this.db.execute(`INSERT OR IGNORE INTO pending_file_deletions(path)
        SELECT ? WHERE NOT EXISTS (SELECT 1 FROM clipboard_items
          WHERE image_path = ? OR thumbnail_path = ?)`, [path, path, path]);
    }
  }

  async flushFileDeletions() {
    const files = await this.db.select<{ path: string }[]>('SELECT path FROM pending_file_deletions');
    const rows = await this.db.select<{ image_path: string | null; thumbnail_path: string | null }[]>(
      'SELECT image_path, thumbnail_path FROM clipboard_items');
    const references = rows.flatMap(row => [row.image_path, row.thumbnail_path])
      .filter((path): path is string => Boolean(path));
    const referenced = new Set(references);
    const failures: string[] = [];
    const removeBatch = async (paths: string[]) => {
      const unreferenced = paths.filter(path => !referenced.has(path));
      if (unreferenced.length) await this.removeImages(unreferenced, references);
      await this.db.execute(`DELETE FROM pending_file_deletions WHERE path IN (${paths.map(() => '?').join(',')})`, paths);
    };
    // Resolve the reference identities once per small batch rather than once
    // per orphan. A failed batch falls back to individual retries so one unsafe
    // or busy file cannot block unrelated cleanup. Queue rows stay durable.
    for (let offset = 0; offset < files.length; offset += 64) {
      const paths = files.slice(offset, offset + 64).map(file => file.path);
      try { await removeBatch(paths); }
      catch {
        for (const path of paths) {
          try { await removeBatch([path]); }
          catch (error) { failures.push(String(error)); }
        }
      }
    }
    if (failures.length) throw new Error(`Image cleanup incomplete (${failures.length} files): ${failures[0]}`);
  }

  async delete(item: ClipboardItem) {
    await this.db.execute('DELETE FROM clipboard_items WHERE id = ?', [item.id]);
  }

  async touch(hash: string) {
    await this.db.execute("UPDATE clipboard_items SET updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE content_hash = ?", [hash]);
  }

  async search(query: string) {
    if (!query.trim()) {
      return this.db.select<ClipboardItem[]>('SELECT * FROM clipboard_items ORDER BY updated_at DESC, id DESC LIMIT 100');
    }
    return this.db.select<ClipboardItem[]>(`SELECT * FROM clipboard_items WHERE text_content LIKE ?
      ORDER BY updated_at DESC, id DESC LIMIT 100`, [`%${query}%`]);
  }
}
