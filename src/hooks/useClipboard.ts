import { useEffect, useState, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import Database from '@tauri-apps/plugin-sql';
import type { ClipboardItem, Settings } from '../types';
import { ClipboardStore, type ClipboardPayload } from '../lib/clipboardStore';

const DB_NAME = 'sqlite:super-paste.db';

export function useClipboard(settings: Settings, settingsReady: boolean) {
  const [items, setItems] = useState<ClipboardItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const storeRef = useRef<ClipboardStore | null>(null);
  const settingsRef = useRef(settings);
  const queryRef = useRef('');
  const queryVersion = useRef(0);
  const workRef = useRef<Promise<unknown>>(Promise.resolve());
  settingsRef.current = settings;

  const enqueue = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = workRef.current.then(operation);
    workRef.current = result.catch(() => {});
    return result;
  }, []);

  const refresh = useCallback(async (store: ClipboardStore) => {
    const version = ++queryVersion.current;
    const result = await store.search(queryRef.current);
    if (version === queryVersion.current) setItems(result);
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let maintenance: ReturnType<typeof setInterval> | undefined;

    const requestDrain = () => {
      if (cancelled) return;
      void enqueue(async () => {
        if (cancelled || !storeRef.current) return;
        const store = storeRef.current;
        const pending = await invoke<ClipboardPayload[]>('pending_clipboard');
        await store.reconcileDeliveries(pending.map(payload => payload.id));
        for (const payload of pending) {
          if (cancelled) return;
          await store.save(payload);
          // The Rust queue retains the payload if SQLite or acknowledgment fails.
          await invoke('acknowledge_clipboard', { id: payload.id });
          await store.acknowledge(payload.id);
        }
        await store.cleanup(settingsRef.current);
        await refresh(store);
        await store.flushFileDeletions();
        const status = await invoke<string | null>('clipboard_status');
        if (!cancelled) setError(status);
      }).catch(reportAndRetry);
    };

    function reportAndRetry(cause: unknown) {
      if (cancelled) return;
      setError(`剪贴板保存或清理失败，将自动重试：${String(cause)}`);
      if (!retry) retry = setTimeout(() => { retry = undefined; requestDrain(); }, 2000);
    }

    async function initialize() {
      const database = await Database.load(DB_NAME);
      const store = new ClipboardStore(database, path => invoke('delete_image_files', {
        imagePath: path, thumbnailPath: null,
      }));
      await enqueue(() => store.initialize());
      if (cancelled) return;
      storeRef.current = store;
      // Register before requesting the snapshot: captures before registration are
      // buffered in Rust, and captures after it wake another serialized drain.
      const off = await listen('clipboard-available', requestDrain);
      if (cancelled) { off(); return; }
      unlisten = off;
      const offStatus = await listen<string | null>('clipboard-status', event => setError(event.payload));
      if (cancelled) { offStatus(); return; }
      unlistenStatus = offStatus;
      requestDrain();
      maintenance = setInterval(requestDrain, 60_000);
    }

    function startInitialization() {
      void initialize().catch(cause => {
        if (cancelled) return;
        unlisten?.();
        unlistenStatus?.();
        unlisten = undefined;
        unlistenStatus = undefined;
        storeRef.current = null;
        setError(`剪贴板初始化失败，将自动重试：${String(cause)}`);
        retry = setTimeout(() => { retry = undefined; startInitialization(); }, 2000);
      });
    }
    startInitialization();
    return () => {
      cancelled = true;
      unlisten?.();
      unlistenStatus?.();
      if (retry) clearTimeout(retry);
      if (maintenance) clearInterval(maintenance);
      storeRef.current = null;
      queryVersion.current += 1;
    };
  }, [settingsReady, enqueue, refresh]);

  // Applying settings also applies retention immediately, without waiting for a copy.
  useEffect(() => {
    if (!settingsReady) return;
    void enqueue(async () => {
      const store = storeRef.current;
      if (!store) return;
      await store.cleanup(settingsRef.current);
      await refresh(store);
      await store.flushFileDeletions();
    }).catch(cause => setError(`剪贴板清理失败：${String(cause)}`));
  }, [settings.max_items, settings.max_days, settingsReady, enqueue, refresh]);

  const searchItems = useCallback(async (query: string) => {
    queryRef.current = query;
    queryVersion.current += 1;
    const store = storeRef.current;
    if (!store) return;
    try { await refresh(store); }
    catch (cause) { setError(`搜索失败：${String(cause)}`); }
  }, [refresh]);

  const updateItemTime = useCallback((hash: string) => enqueue(async () => {
    const store = storeRef.current;
    if (!store) throw new Error('Clipboard database is not ready');
    await store.touch(hash);
    await refresh(store);
  }), [enqueue, refresh]);

  const deleteItem = useCallback((item: ClipboardItem) => enqueue(async () => {
    const store = storeRef.current;
    if (!store) throw new Error('Clipboard database is not ready');
    await store.delete(item);
    await refresh(store);
    try { await store.flushFileDeletions(); }
    catch (cause) { setError(`图片清理失败，将自动重试：${String(cause)}`); }
  }), [enqueue, refresh]);

  return { items, updateItemTime, searchItems, deleteItem, error };
}
