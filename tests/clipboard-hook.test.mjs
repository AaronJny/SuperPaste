import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function compile(relative, dependencies, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const context = { exports: {}, require(name) { if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`); return dependencies[name]; }, ...globals };
  vm.runInNewContext(code, context);
  return context.exports;
}
const storeModule = compile('../src/lib/clipboardStore.ts', {});
const settings = { shortcut: 'CommandOrControl+Shift+V', max_items: 1000, max_days: 30, max_file_size_mb: 10 };
const payload = id => ({ id, content_type: 'text', content_hash: id, text_content: id, image_path: null, thumbnail_path: null, file_size: id.length });
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ initialPending = [], ready = true, failAck = false, failLoad = false } = {}) {
  const sql = new DatabaseSync(':memory:');
  const state = [], effects = [], timers = [], calls = [], events = new Map();
  let pending = [...initialPending], loaded = 0;
  const db = {
    async execute(query, values = []) { return sql.prepare(query).run(...values); },
    async select(query, values = []) { return sql.prepare(query).all(...values); },
  };
  const react = {
    useState(initial) { const index = state.length; state.push(initial); return [initial, value => { state[index] = value; }]; },
    useRef(current) { return { current }; }, useCallback(callback) { return callback; }, useEffect(effect) { effects.push(effect); },
  };
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'pending_clipboard') return [...pending];
    if (command === 'clipboard_status') return null;
    if (command === 'acknowledge_clipboard') {
      if (failAck) { failAck = false; throw new Error('Transient acknowledgment failure'); }
      assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM clipboard_deliveries WHERE id=?').get(args.id).n, 1, 'durable receipt before ack');
      pending = pending.filter(item => item.id !== args.id); return;
    }
    if (command === 'delete_image_files') return;
    throw new Error(`Unexpected command ${command}`);
  };
  const { useClipboard } = compile('../src/hooks/useClipboard.ts', {
    react, '@tauri-apps/api/core': { invoke }, '@tauri-apps/api/event': { async listen(name, callback) { events.set(name, callback); return () => events.delete(name); } },
    '@tauri-apps/plugin-sql': { async load() { loaded++; if (failLoad) { failLoad = false; throw new Error('Transient database load failure'); } return db; } },
    '../lib/clipboardStore': storeModule,
  }, { setTimeout(fn) { timers.push(fn); return fn; }, clearTimeout(fn) { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1); }, setInterval() { return 1; }, clearInterval() {} });
  const hook = useClipboard(settings, ready);
  const disposers = effects.map(effect => effect());
  return { hook, state, calls, timers, db, sql, events, get pending() { return pending; }, get loaded() { return loaded; },
    capture(item) { pending.push(item); events.get('clipboard-available')?.({ payload: null }); },
    dispose() { disposers.forEach(fn => fn?.()); sql.close(); } };
}

test('startup captures buffered before JS listeners are persisted before acknowledgment', async () => {
  const f = fixture({ initialPending: [payload('before-listener')] }); await settle();
  assert.equal(f.pending.length, 0); assert.equal(f.state[0][0].text_content, 'before-listener');
  assert.ok(f.events.has('clipboard-available')); f.dispose();
});

test('failed acknowledgment replays safely without duplicate rows', async () => {
  const f = fixture({ initialPending: [payload('retry')], failAck: true }); await settle();
  assert.equal(f.pending.length, 1); assert.equal(f.timers.length, 1);
  f.timers.shift()(); await settle();
  assert.equal(f.pending.length, 0); assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM clipboard_items').get().n, 1); f.dispose();
});

test('initialization failure automatically retries before processing buffered captures', async () => {
  const f = fixture({ initialPending: [payload('not-lost')], failLoad: true }); await settle();
  assert.equal(f.loaded, 1); assert.equal(f.pending.length, 1);
  f.timers.shift()(); await settle(); assert.equal(f.loaded, 2); assert.equal(f.pending.length, 0); f.dispose();
});

test('no database initialization or cleanup before trustworthy settings are ready', async () => {
  const f = fixture({ ready: false }); await settle(); assert.equal(f.loaded, 0); assert.equal(f.calls.length, 0); f.dispose();
});

test('capture and delete refresh the active query rather than the full list', async () => {
  const f = fixture({ initialPending: [payload('apple'), payload('banana')] }); await settle();
  await f.hook.searchItems('apple'); assert.deepEqual(Array.from(f.state[0], x => x.text_content), ['apple']);
  f.capture(payload('cherry')); await settle(); assert.deepEqual(Array.from(f.state[0], x => x.text_content), ['apple']);
  await f.hook.deleteItem(f.state[0][0]); assert.equal(f.state[0].length, 0);
  await f.hook.searchItems(''); assert.equal(f.state[0].length, 2); f.dispose();
});


test('ack retry after a user deletes the persisted record does not resurrect history', async () => {
  const f = fixture({ initialPending: [payload('delete-before-ack')], failAck: true }); await settle();
  await f.hook.searchItems(''); assert.equal(f.state[0].length, 1);
  await f.hook.deleteItem(f.state[0][0]); assert.equal(f.state[0].length, 0);
  f.timers.shift()(); await settle();
  assert.equal(f.pending.length, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM clipboard_items').get().n, 0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM clipboard_deliveries').get().n, 0);
  f.dispose();
});
