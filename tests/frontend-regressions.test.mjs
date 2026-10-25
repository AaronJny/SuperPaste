import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Uses the existing TypeScript dev dependency, without a browser or test framework.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadTypeScript(relative, mocks = {}, cache = new Map()) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const source = fs.readFileSync(filename, 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  cache.set(filename, module);
  const localRequire = specifier => {
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    if (specifier.startsWith('.')) {
      const base = path.resolve(path.dirname(filename), specifier);
      const found = [base + '.ts', base + '.tsx', path.join(base, 'index.ts')].find(file => fs.existsSync(file));
      if (!found) throw new Error(`Cannot resolve ${specifier} in ${filename}`);
      return loadTypeScript(found, mocks, cache);
    }
    return require(specifier);
  };
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  return module.exports;
}

function reactHarness() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!equal(slots[index]?.deps, deps)) slots[index] = { value: callback, deps };
      return slots[index].value;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!equal(slots[index]?.deps, deps)) {
        const previous = slots[index];
        slots[index] = { deps };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); });
      }
    },
  };
  return {
    hooks,
    jsx: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    render(component, props) {
      cursor = 0;
      const result = component(props);
      const pending = effects;
      effects = [];
      pending.forEach(effect => effect());
      return result;
    },
    cleanup() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return undefined;
  if (predicate(tree)) return tree;
  const children = tree.props?.children;
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
    const match = find(child, predicate);
    if (match) return match;
  }
}

const { DEFAULT_SETTINGS, validateSettings, parseStoredSettings, persistSettingsUpdate } = loadTypeScript('src/utils/settings.ts');
const { getPanelKeyAction } = loadTypeScript('src/utils/keyboard.ts');
const keyEvent = (key, extra = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false, ...extra });
const selected = { settingsOpen: false, searchFocused: false, interactiveTarget: false, hasSelection: true, hasItems: true };

test('modal and editable fields cannot delete, paste, or copy clipboard cards', () => {
  for (const key of ['Backspace', 'Delete', 'Enter', 'c']) {
    assert.equal(getPanelKeyAction(keyEvent(key, { ctrlKey: key === 'c' }), { ...selected, settingsOpen: true }), null);
    assert.equal(getPanelKeyAction(keyEvent(key, { ctrlKey: key === 'c' }), { ...selected, interactiveTarget: true }), null);
    assert.equal(getPanelKeyAction(keyEvent(key, { ctrlKey: key === 'c' }), { ...selected, searchFocused: true }), null);
  }
  assert.equal(getPanelKeyAction(keyEvent('Escape'), { ...selected, settingsOpen: true }), 'close-settings');
});

test('both Ctrl+C and Cmd+C copy; modifiers, IME and repeated destructive keys stay safe', () => {
  assert.equal(getPanelKeyAction(keyEvent('c', { ctrlKey: true }), selected), 'copy');
  assert.equal(getPanelKeyAction(keyEvent('c', { metaKey: true }), selected), 'copy');
  assert.equal(getPanelKeyAction(keyEvent('c', { ctrlKey: true, shiftKey: true }), selected), null);
  for (const key of ['Enter', 'Backspace', 'Delete']) {
    assert.equal(getPanelKeyAction(keyEvent(key, { isComposing: true }), selected), null);
    assert.equal(getPanelKeyAction(keyEvent(key, { repeat: true }), selected), null);
    assert.equal(getPanelKeyAction(keyEvent(key), { ...selected, hasSelection: false }), null);
  }
});

test('empty history cannot enter a nonexistent card selection', () => {
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowDown']) {
    assert.equal(getPanelKeyAction(keyEvent(key), { ...selected, hasItems: false, hasSelection: false }), null);
  }
  assert.equal(getPanelKeyAction(keyEvent('ArrowDown'), { ...selected, searchFocused: true }), 'enter-cards');
});

test('all retention fields reject fractions, NaN, and out-of-range values', () => {
  const ranges = { max_items: [100, 5000], max_days: [1, 365], max_file_size_mb: [1, 10] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    for (const value of [min, max]) assert.equal(validateSettings({ ...DEFAULT_SETTINGS, [key]: value }), null);
    for (const value of [min - 1, max + 1, min + 0.1, NaN, Infinity, undefined]) assert.ok(validateSettings({ ...DEFAULT_SETTINGS, [key]: value }));
  }
});

test('corrupt persisted retention uses safe defaults instead of parseInt truncation', () => {
  const parsed = parseStoredSettings([
    { key: 'shortcut', value: 'Control+Alt+V' },
    { key: 'max_items', value: '99999' },
    { key: 'max_days', value: '12days' },
    { key: 'max_file_size_mb', value: '1.5' },
  ]);
  assert.deepEqual(parsed.settings, { ...DEFAULT_SETTINGS, shortcut: 'Control+Alt+V' });
  assert.deepEqual(parsed.invalidKeys, ['max_items', 'max_days', 'max_file_size_mb']);
});

test('settings register first, persist canonical shortcut atomically, then return new state', async () => {
  const calls = [];
  const next = await persistSettingsUpdate(DEFAULT_SETTINGS, { shortcut: 'Control+Alt+V', max_days: 90 }, {
    registerShortcut: async shortcut => { calls.push(['register', shortcut]); return 'control+alt+KeyV'; },
    execute: async (sql, values) => { calls.push(['write', sql, values]); },
  });
  assert.deepEqual(calls.map(call => call[0]), ['register', 'write']);
  assert.equal(calls[1][1].match(/INSERT OR REPLACE/g).length, 1);
  assert.equal(calls[1][2].length, 8);
  assert.ok(calls[1][2].includes('control+alt+KeyV'));
  assert.equal(next.shortcut, 'control+alt+KeyV');
  assert.equal(next.max_days, 90);
  assert.equal(DEFAULT_SETTINGS.max_days, 30);
});

test('shortcut registration rejection cannot persist or publish new settings', async () => {
  let writes = 0;
  await assert.rejects(persistSettingsUpdate(DEFAULT_SETTINGS, { shortcut: 'taken' }, {
    registerShortcut: async () => { throw new Error('already registered'); },
    execute: async () => { writes++; },
  }), /already registered/);
  assert.equal(writes, 0);
});

test('database failure restores the old registration and reports failure', async () => {
  const registered = [];
  await assert.rejects(persistSettingsUpdate(DEFAULT_SETTINGS, { shortcut: 'Control+Alt+V' }, {
    registerShortcut: async shortcut => { registered.push(shortcut); return shortcut; },
    execute: async () => { throw new Error('disk full'); },
  }), /disk full/);
  assert.deepEqual(registered, ['Control+Alt+V', DEFAULT_SETTINGS.shortcut]);
});

test('rollback failure is explicit rather than a saved-success result', async () => {
  let attempts = 0;
  await assert.rejects(persistSettingsUpdate(DEFAULT_SETTINGS, { shortcut: 'Control+Alt+V' }, {
    registerShortcut: async shortcut => { if (++attempts > 1) throw new Error('restore denied'); return shortcut; },
    execute: async () => { throw new Error('disk full'); },
  }), /恢复原快捷键失败.*Control\+Alt\+V/);
});

test('invalid values never register shortcuts or write any rows', async () => {
  let actions = 0;
  await assert.rejects(persistSettingsUpdate(DEFAULT_SETTINGS, { max_items: 2.5 }, {
    registerShortcut: async value => { actions++; return value; },
    execute: async () => { actions++; },
  }), /整数/);
  assert.equal(actions, 0);
});

test('startup registers the saved shortcut, not a JS callback/default shortcut', async () => {
  const harness = reactHarness();
  const calls = [];
  const database = { execute: async () => {}, select: async () => [{ key: 'shortcut', value: 'Control+Alt+C' }] };
  const { useSettings } = loadTypeScript('src/hooks/useSettings.ts', {
    react: harness.hooks,
    '@tauri-apps/plugin-sql': { default: { load: async () => database }, __esModule: true },
    '@tauri-apps/api/core': { invoke: async (command, args) => { calls.push([command, args]); return 'control+alt+KeyC'; } },
  });
  assert.equal(harness.render(useSettings).loading, true);
  await flush();
  const result = harness.render(useSettings);
  assert.deepEqual(calls, [['set_shortcut', { shortcut: 'Control+Alt+C' }]]);
  assert.equal(result.settings.shortcut, 'control+alt+KeyC');
  assert.equal(result.loading, false);
  assert.equal(result.historyReady, true);
  assert.equal(result.error, null);
  harness.cleanup();
});

test('startup shortcut failure visibly falls back and failed save does not publish state', async () => {
  const harness = reactHarness();
  const registrations = [];
  let failWrite = false;
  const database = {
    execute: async sql => { if (failWrite && sql.startsWith('INSERT')) throw new Error('disk full'); },
    select: async () => [{ key: 'shortcut', value: 'taken' }],
  };
  const { useSettings } = loadTypeScript('src/hooks/useSettings.ts', {
    react: harness.hooks,
    '@tauri-apps/plugin-sql': { default: { load: async () => database }, __esModule: true },
    '@tauri-apps/api/core': { invoke: async (_command, { shortcut }) => {
      registrations.push(shortcut);
      if (shortcut === 'taken') throw new Error('occupied');
      return shortcut;
    } },
  });
  harness.render(useSettings);
  await flush();
  let result = harness.render(useSettings);
  assert.equal(result.settings.shortcut, DEFAULT_SETTINGS.shortcut);
  assert.match(result.error, /默认快捷键/);
  failWrite = true;
  assert.equal(await result.updateSettings({ shortcut: 'Control+Alt+C', max_days: 60 }), false);
  result = harness.render(useSettings);
  assert.equal(result.settings.shortcut, DEFAULT_SETTINGS.shortcut);
  assert.equal(result.settings.max_days, 30);
  assert.match(result.error, /disk full/);
  assert.deepEqual(registrations, ['taken', DEFAULT_SETTINGS.shortcut, 'Control+Alt+C', DEFAULT_SETTINGS.shortcut]);
  harness.cleanup();
});

test('settings form neither reports success nor closes when persistence returns false', async () => {
  const harness = reactHarness();
  const originalDocument = globalThis.document;
  globalThis.document = { activeElement: null };
  try {
    let closed = 0;
    let saves = 0;
    const { default: SettingsPanel } = loadTypeScript('src/components/SettingsPanel.tsx', {
      react: harness.hooks, 'react/jsx-runtime': harness.jsx,
    });
    const props = { settings: DEFAULT_SETTINGS, onClose: () => { closed++; }, onUpdateSettings: async () => { saves++; return false; } };
    let tree = harness.render(SettingsPanel, props);
    await find(tree, element => element.props?.className === 'btn-primary').props.onClick();
    tree = harness.render(SettingsPanel, props);
    const message = find(tree, element => element.props?.className === 'settings-message error');
    assert.match(message.props.children, /保存失败/);
    assert.equal(find(tree, element => element.props?.className === 'settings-message success'), undefined);
    assert.equal(closed, 0);
    assert.equal(saves, 1);
    // Empty/decimal input remains editable, but can never be saved as a default/truncated number.
    find(tree, element => element.props?.id === 'max-items').props.onChange({ target: { value: '100.5' } });
    tree = harness.render(SettingsPanel, props);
    await find(tree, element => element.props?.className === 'btn-primary').props.onClick();
    assert.equal(saves, 1);
    harness.cleanup();
  } finally { globalThis.document = originalDocument; }
});

test('App resets search results on reopen, isolates modal keys, and supports Ctrl+C', async () => {
  const harness = reactHarness();
  const previous = { window: globalThis.window, Element: globalThis.Element, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const handlers = new Map();
  const events = new Map();
  const searches = [];
  const invokes = [];
  let focusHandler;
  let copiedTimes = 0;
  let deleted = 0;
  let focused = false;
  const items = [{ id: 1, content_type: 'text', text_content: 'synthetic fixture', content_hash: 'test' }];
  globalThis.Element = class {};
  globalThis.window = { addEventListener: (type, fn) => handlers.set(type, fn), removeEventListener: (type, fn) => { if (handlers.get(type) === fn) handlers.delete(type); } };
  globalThis.requestAnimationFrame = callback => { callback(); return 1; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const { default: App } = loadTypeScript('src/App.tsx', {
      react: harness.hooks, 'react/jsx-runtime': harness.jsx,
      '@tauri-apps/api/core': { invoke: async (command, args) => { invokes.push([command, args]); } },
      '@tauri-apps/api/event': { listen: async (name, callback) => { events.set(name, callback); return () => events.delete(name); } },
      '@tauri-apps/api/window': { getCurrentWindow: () => ({ onFocusChanged: async callback => { focusHandler = callback; return () => {}; } }) },
      './hooks/useSettings': { useSettings: () => ({ settings: DEFAULT_SETTINGS, loading: false, historyReady: true, error: null, updateSettings: async () => true }) },
      './hooks/useClipboard': { useClipboard: (settings, ready) => {
        assert.equal(settings, DEFAULT_SETTINGS); assert.equal(ready, true);
        return { items, updateItemTime: async () => { copiedTimes++; }, searchItems: async query => { searches.push(query); }, deleteItem: async () => { deleted++; }, error: null };
      } },
      './components/SearchBar': { default: 'SearchBar', __esModule: true },
      './components/ClipboardCard': { default: 'ClipboardCard', __esModule: true },
      './components/SettingsPanel': { default: 'SettingsPanel', __esModule: true },
    });
    let tree = harness.render(App);
    const search = find(tree, element => element.type === 'SearchBar');
    search.props.ref.current = { focus: () => { focused = true; }, blur: () => { focused = false; }, isFocused: () => focused };
    search.props.onChange('filtered');
    tree = harness.render(App);
    assert.equal(find(tree, element => element.type === 'SearchBar').props.value, 'filtered');
    events.get('panel-show')();
    tree = harness.render(App);
    assert.equal(find(tree, element => element.type === 'SearchBar').props.value, '');
    assert.equal(searches.at(-1), '');
    handlers.get('keydown')({ ...keyEvent('ArrowDown'), preventDefault() {}, target: null });
    tree = harness.render(App);
    find(tree, element => element.props?.className === 'settings-btn').props.onClick();
    tree = harness.render(App);
    for (const key of ['Delete', 'Backspace', 'Enter']) handlers.get('keydown')({ ...keyEvent(key), preventDefault() {}, target: null });
    await flush();
    assert.equal(deleted, 0);
    assert.equal(invokes.length, 0);
    handlers.get('keydown')({ ...keyEvent('Escape'), preventDefault() {}, target: null });
    tree = harness.render(App);
    assert.equal(find(tree, element => element.type === 'SettingsPanel'), undefined);
    assert.equal(invokes.length, 0);
    handlers.get('keydown')({ ...keyEvent('c', { ctrlKey: true }), preventDefault() {}, target: null });
    await flush();
    assert.deepEqual(invokes.map(([command]) => command), ['copy_to_clipboard', 'hide_window']);
    assert.equal(copiedTimes, 1);
    focusHandler({ payload: false });
    await flush();
    assert.deepEqual(invokes.at(-1), ['hide_window', { restoreFocus: false }]);
    harness.cleanup();
  } finally { Object.assign(globalThis, previous); }
});

test('unreadable or corrupt retention never enables history cleanup before an explicit successful save', async () => {
  for (const failRead of [false, true]) {
    const harness = reactHarness();
    const database = {
      execute: async () => {},
      select: async () => {
        if (failRead) throw new Error('temporary database failure');
        return [{ key: 'max_days', value: 'invalid' }];
      },
    };
    const { useSettings } = loadTypeScript('src/hooks/useSettings.ts', {
      react: harness.hooks,
      '@tauri-apps/plugin-sql': { default: { load: async () => database }, __esModule: true },
      '@tauri-apps/api/core': { invoke: async (_command, { shortcut }) => shortcut },
    });
    harness.render(useSettings);
    await flush();
    let result = harness.render(useSettings);
    assert.equal(result.loading, false);
    assert.equal(result.historyReady, false);
    assert.match(result.error, /清理已暂停/);
    assert.equal(await result.updateSettings({ max_days: 365 }), true);
    result = harness.render(useSettings);
    assert.equal(result.historyReady, true);
    assert.equal(result.settings.max_days, 365);
    harness.cleanup();
  }
});

test('queued settings updates preserve earlier saved fields instead of racing stale state', async () => {
  const harness = reactHarness();
  const writes = [];
  const database = {
    execute: async (sql, values) => { if (sql.startsWith('INSERT')) writes.push(values); },
    select: async () => [],
  };
  const { useSettings } = loadTypeScript('src/hooks/useSettings.ts', {
    react: harness.hooks,
    '@tauri-apps/plugin-sql': { default: { load: async () => database }, __esModule: true },
    '@tauri-apps/api/core': { invoke: async (_command, { shortcut }) => shortcut },
  });
  harness.render(useSettings);
  await flush();
  let result = harness.render(useSettings);
  const first = result.updateSettings({ max_days: 90 });
  const second = result.updateSettings({ max_items: 500 });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  result = harness.render(useSettings);
  assert.equal(result.settings.max_days, 90);
  assert.equal(result.settings.max_items, 500);
  assert.equal(writes.length, 2);
  assert.ok(writes[1].includes('90'));
  harness.cleanup();
});

test('saving retries the same shortcut when its startup registration failed', async () => {
  const harness = reactHarness();
  let attempts = 0;
  const database = { execute: async () => {}, select: async () => [] };
  const { useSettings } = loadTypeScript('src/hooks/useSettings.ts', {
    react: harness.hooks,
    '@tauri-apps/plugin-sql': { default: { load: async () => database }, __esModule: true },
    '@tauri-apps/api/core': { invoke: async (_command, { shortcut }) => {
      if (++attempts === 1) throw new Error('temporary registration failure');
      return shortcut;
    } },
  });
  harness.render(useSettings);
  await flush();
  let result = harness.render(useSettings);
  assert.match(result.error, /快捷键/);
  assert.equal(await result.updateSettings({ max_days: 90 }), true);
  result = harness.render(useSettings);
  assert.equal(attempts, 2);
  assert.equal(result.error, null);
  assert.equal(result.settings.max_days, 90);
  harness.cleanup();
});
