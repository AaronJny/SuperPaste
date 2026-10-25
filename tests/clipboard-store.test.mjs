import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/lib/clipboardStore.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const scope = { exports: {}, require() { throw new Error('Unexpected runtime dependency'); } };
vm.runInNewContext(compiled, scope);
const { ClipboardStore } = scope.exports;
const settings = { shortcut: 'CommandOrControl+Shift+V', max_items: 2000, max_days: 365, max_file_size_mb: 10 };
function fixture() {
  const sql = new DatabaseSync(':memory:');
  const removed = [];
  let failRemoval = false;
  const db = {
    async execute(query, values = []) { return sql.prepare(query).run(...values); },
    async select(query, values = []) { return sql.prepare(query).all(...values); },
  };
  const store = new ClipboardStore(db, async path => {
    if (failRemoval) throw new Error('File is temporarily busy');
    removed.push(path);
  });
  return { sql, store, removed, setRemovalFailure(value) { failRemoval = value; } };
}
function text(hash, content = hash) {
  return { id: hash, content_type: 'text', content_hash: hash, text_content: content, image_path: null, thumbnail_path: null, file_size: content.length };
}
function image(hash, suffix = hash) {
  return { ...text(hash), id: `${hash}-${suffix}`, content_type: 'image', text_content: null, image_path: `/app/images/${suffix}.png`, thumbnail_path: `/app/images/${suffix}_thumb.png` };
}

test('retention uses both saved limits and rejects invalid destructive defaults', async () => {
  const { sql, store } = fixture(); await store.initialize();
  const insert = sql.prepare("INSERT INTO clipboard_items(content_type,content_hash,text_content,updated_at) VALUES ('text',?,?,datetime('now'))");
  for (let i = 0; i < 1001; i++) insert.run(`item${i}`, `item${i}`);
  sql.prepare("UPDATE clipboard_items SET updated_at=datetime('now','-31 days') WHERE content_hash='item0'").run();
  await store.cleanup(settings);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM clipboard_items').get().n, 1001);
  await assert.rejects(store.cleanup({ ...settings, max_items: NaN }));
  await store.cleanup({ ...settings, max_items: 100, max_days: 1 });
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM clipboard_items').get().n, 100);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM clipboard_items WHERE content_hash='item0'").get().n, 0);
  sql.close();
});

test('duplicate capture removes only new files; acknowledgment replay preserves stored files', async () => {
  const { sql, store, removed } = fixture(); await store.initialize();
  await store.save(image('same', 'original')); await store.save(image('same', 'duplicate'));
  await store.flushFileDeletions();
  assert.deepEqual(removed.sort(), ['/app/images/duplicate.png', '/app/images/duplicate_thumb.png']);
  assert.equal(sql.prepare('SELECT image_path FROM clipboard_items').get().image_path, '/app/images/original.png');
  await store.save(image('same', 'original')); await store.flushFileDeletions();
  assert.equal(removed.length, 2);
  sql.close();
});

test('retention and manual deletion durably queue originals and thumbnails for retries', async () => {
  const { sql, store, removed, setRemovalFailure } = fixture(); await store.initialize();
  await store.save(image('expired'));
  sql.exec("UPDATE clipboard_items SET updated_at=datetime('now','-40 days')");
  await store.cleanup({ ...settings, max_days: 30 });
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM clipboard_items').get().n, 0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM pending_file_deletions').get().n, 2);
  setRemovalFailure(true); await assert.rejects(store.flushFileDeletions());
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM pending_file_deletions').get().n, 2);
  setRemovalFailure(false); await store.flushFileDeletions();
  assert.equal(removed.length, 2);
  await store.save(image('manual'));
  await store.delete(sql.prepare('SELECT * FROM clipboard_items').get());
  await store.flushFileDeletions();
  assert.equal(removed.length, 4);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM pending_file_deletions').get().n, 0);
  sql.close();
});

test('referenced files are never removed even if queued by a removed row', async () => {
  const { sql, store, removed } = fixture(); await store.initialize();
  await store.save(image('first', 'shared')); await store.save(image('second', 'shared'));
  await store.delete(sql.prepare("SELECT * FROM clipboard_items WHERE content_hash='first'").get());
  await store.flushFileDeletions();
  assert.equal(removed.length, 0); sql.close();
});

test('search remains filtered when refreshed after captures and deletions', async () => {
  const { sql, store } = fixture(); await store.initialize();
  await store.save(text('apple')); await store.save(text('banana'));
  assert.deepEqual(Array.from(await store.search('apple'), x => x.text_content), ['apple']);
  await store.save(text('cherry'));
  const found = await store.search('apple');
  assert.deepEqual(Array.from(found, x => x.text_content), ['apple']);
  await store.delete(found[0]);
  assert.equal((await store.search('apple')).length, 0);
  assert.equal((await store.search('')).length, 2); sql.close();
});


test('acknowledgment failure followed by deletion cannot resurrect text or deleted image files', async () => {
  const { sql, store, removed } = fixture(); await store.initialize();
  for (const capture of [text('once'), image('photo')]) {
    await store.save(capture);
    const item = sql.prepare('SELECT * FROM clipboard_items WHERE content_hash=?').get(capture.content_hash);
    await store.delete(item); await store.flushFileDeletions();
    await store.save(capture); // Replayed after a failed acknowledgment.
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM clipboard_items WHERE content_hash=?').get(capture.content_hash).n, 0);
  }
  assert.equal(removed.length, 2);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM clipboard_deliveries WHERE text_content IS NOT NULL OR image_path IS NOT NULL').get().n, 0);
  await store.reconcileDeliveries([]);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM clipboard_deliveries').get().n, 0);
  sql.close();
});

test('receipts keep pending IDs but release confirmed acknowledgments without holding content', async () => {
  const { sql, store } = fixture(); await store.initialize();
  await store.save(text('first')); await store.save(text('second'));
  await store.reconcileDeliveries(['second']);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM clipboard_deliveries').get().n, 1);
  assert.equal(sql.prepare('SELECT id FROM clipboard_deliveries').get().id, 'second');
  await store.acknowledge('second');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM clipboard_deliveries').get().n, 0);
  sql.close();
});
