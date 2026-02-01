import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import Database from '@tauri-apps/plugin-sql';
import type { Settings } from '../types';

const DB_NAME = 'sqlite:super-paste.db';
const DEFAULT_SETTINGS: Settings = {
  shortcut: 'CommandOrControl+Shift+V',
  max_items: 1000,
  max_days: 30,
  max_file_size_mb: 10,
};

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const db = await Database.load(DB_NAME);
      
      await db.execute(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);

      const rows = await db.select<{ key: string; value: string }[]>(
        'SELECT key, value FROM settings'
      );

      if (rows.length > 0) {
        const loaded: Partial<Settings> = {};
        for (const row of rows) {
          if (row.key === 'shortcut') loaded.shortcut = row.value;
          if (row.key === 'max_items') loaded.max_items = parseInt(row.value);
          if (row.key === 'max_days') loaded.max_days = parseInt(row.value);
          if (row.key === 'max_file_size_mb') loaded.max_file_size_mb = parseInt(row.value);
        }
        setSettings({ ...DEFAULT_SETTINGS, ...loaded });
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
    } finally {
      setLoading(false);
    }
  };

  const updateShortcut = useCallback(async (newShortcut: string) => {
    try {
      // Unregister old shortcut
      await unregister(settings.shortcut);
      
      // Register new shortcut
      await register(newShortcut, () => {
        invoke('show_window');
      });

      // Save to database
      const db = await Database.load(DB_NAME);
      await db.execute(
        `INSERT OR REPLACE INTO settings (key, value) VALUES ('shortcut', ?)`,
        [newShortcut]
      );

      setSettings(prev => ({ ...prev, shortcut: newShortcut }));
      return true;
    } catch (e) {
      console.error('Failed to update shortcut:', e);
      // Re-register old shortcut on failure
      await register(settings.shortcut, () => {
        invoke('show_window');
      });
      return false;
    }
  }, [settings.shortcut]);

  const updateSettings = useCallback(async (updates: Partial<Settings>) => {
    try {
      const db = await Database.load(DB_NAME);
      
      for (const [key, value] of Object.entries(updates)) {
        if (key !== 'shortcut') {
          await db.execute(
            `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
            [key, String(value)]
          );
        }
      }

      setSettings(prev => ({ ...prev, ...updates }));
      return true;
    } catch (e) {
      console.error('Failed to update settings:', e);
      return false;
    }
  }, []);

  return { settings, loading, updateShortcut, updateSettings };
}
