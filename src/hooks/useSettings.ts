import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Database from '@tauri-apps/plugin-sql';
import type { Settings } from '../types';
import { DEFAULT_SETTINGS, parseStoredSettings, persistSettingsUpdate } from '../utils/settings';

const DB_NAME = 'sqlite:super-paste.db';
type SettingsDatabase = Awaited<ReturnType<typeof Database.load>>;

export function useSettings() {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS });
  const [loading, setLoading] = useState(true);
  const [historyReady, setHistoryReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settingsRef = useRef(settings);
  const dbRef = useRef<SettingsDatabase | null>(null);
  const readyRef = useRef(false);
  const startupRef = useRef<Promise<{ settings: Settings; error: string | null; historyReady: boolean }> | null>(null);
  const updateQueue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    // StrictMode can replay effects; do not race duplicate startup registrations.
    if (!startupRef.current) {
      startupRef.current = (async () => {
        let loaded = { ...DEFAULT_SETTINGS };
        const warnings: string[] = [];
        let safeToLoadHistory = false;
        try {
          const db = await Database.load(DB_NAME);
          await db.execute('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
          const rows = await db.select<{ key: string; value: string }[]>('SELECT key, value FROM settings');
          const parsed = parseStoredSettings(rows);
          loaded = parsed.settings;
          dbRef.current = db;
          safeToLoadHistory = !parsed.invalidKeys.some(key => key !== 'shortcut');
          if (parsed.invalidKeys.length) warnings.push('部分已保存的设置无效，已显示默认值');
          if (!safeToLoadHistory) warnings.push('历史记录清理已暂停；请确认保留期限并保存设置后恢复');
        } catch (cause) {
          warnings.push(`无法读取设置，历史记录清理已暂停；请重启重试，或确认设置并保存后恢复：${String(cause)}`);
        }

        try {
          loaded.shortcut = await invoke<string>('set_shortcut', { shortcut: loaded.shortcut });
        } catch (cause) {
          warnings.push(`无法启用已保存的快捷键：${String(cause)}`);
          if (loaded.shortcut !== DEFAULT_SETTINGS.shortcut) {
            try {
              loaded.shortcut = await invoke<string>('set_shortcut', { shortcut: DEFAULT_SETTINGS.shortcut });
              warnings.push('已改用默认快捷键；请在设置中重新保存');
            } catch (fallbackError) {
              warnings.push(`默认快捷键也不可用，请通过托盘打开并重新设置：${String(fallbackError)}`);
            }
          } else {
            warnings.push('请通过托盘打开并重新设置快捷键');
          }
        }
        return { settings: loaded, error: warnings.length ? warnings.join('。') : null, historyReady: safeToLoadHistory };
      })();
    }
    startupRef.current.then(result => {
      if (cancelled) return;
      settingsRef.current = result.settings;
      readyRef.current = true;
      setSettings(result.settings);
      setHistoryReady(result.historyReady);
      setError(result.error);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const updateSettings = useCallback((updates: Partial<Settings>): Promise<boolean> => {
    const operation = updateQueue.current.then(async () => {
      if (!readyRef.current) {
        setError('设置仍在加载，请稍后重试');
        return false;
      }
      try {
        let db = dbRef.current;
        if (!db) {
          db = await Database.load(DB_NAME);
          await db.execute('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
          dbRef.current = db;
        }
        const next = await persistSettingsUpdate(settingsRef.current, updates, {
          registerShortcut: shortcut => invoke<string>('set_shortcut', { shortcut }),
          execute: (query, values) => db.execute(query, values),
        });
        settingsRef.current = next;
        setSettings(next);
        setHistoryReady(true);
        setError(null);
        return true;
      } catch (cause) {
        setError(`保存设置失败：${String(cause)}`);
        return false;
      }
    });
    updateQueue.current = operation;
    return operation;
  }, []);

  const updateShortcut = useCallback((shortcut: string) => updateSettings({ shortcut }), [updateSettings]);
  return { settings, loading, historyReady, error, updateShortcut, updateSettings };
}
