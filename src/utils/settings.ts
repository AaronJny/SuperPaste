import type { Settings } from '../types';

export const DEFAULT_SETTINGS: Settings = {
  shortcut: 'CommandOrControl+Shift+V',
  max_items: 1000,
  max_days: 30,
  max_file_size_mb: 10,
};

export const SETTINGS_LIMITS = {
  max_items: { min: 100, max: 5000, label: '最大保存条数' },
  max_days: { min: 1, max: 365, label: '保存天数' },
  max_file_size_mb: { min: 1, max: 10, label: '单个图片大小（MB）' },
} as const;

const RETENTION_KEYS = Object.keys(SETTINGS_LIMITS) as (keyof typeof SETTINGS_LIMITS)[];
const SETTING_KEYS = ['shortcut', ...RETENTION_KEYS] as (keyof Settings)[];

export function validateSettings(settings: Settings): string | null {
  if (typeof settings.shortcut !== 'string' || !settings.shortcut.trim()) {
    return '请选择有效的快捷键';
  }
  for (const key of RETENTION_KEYS) {
    const { min, max, label } = SETTINGS_LIMITS[key];
    if (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max) {
      return `${label}必须为 ${min} 到 ${max} 之间的整数`;
    }
  }
  return null;
}

/** Corrupt stored values must not silently disable retention or admit oversized files. */
export function parseStoredSettings(rows: { key: string; value: string }[]): {
  settings: Settings;
  invalidKeys: string[];
} {
  const settings = { ...DEFAULT_SETTINGS };
  const invalidKeys: string[] = [];
  for (const { key, value } of rows) {
    if (key === 'shortcut') {
      if (value.trim()) settings.shortcut = value.trim();
      else invalidKeys.push(key);
    } else if (RETENTION_KEYS.includes(key as keyof typeof SETTINGS_LIMITS)) {
      const retentionKey = key as keyof typeof SETTINGS_LIMITS;
      const number = Number(value);
      const { min, max } = SETTINGS_LIMITS[retentionKey];
      if (value.trim() && Number.isInteger(number) && number >= min && number <= max) {
        settings[retentionKey] = number;
      } else {
        invalidKeys.push(key);
      }
    }
  }
  return { settings, invalidKeys };
}

interface SettingsWriter {
  registerShortcut: (shortcut: string) => Promise<string>;
  execute: (query: string, values: unknown[]) => Promise<unknown>;
}

/** Register first; write all fields atomically; only then let the caller publish state. */
export async function persistSettingsUpdate(
  previous: Settings,
  updates: Partial<Settings>,
  writer: SettingsWriter,
): Promise<Settings> {
  if (Object.keys(updates).some(key => !SETTING_KEYS.includes(key as keyof Settings))) {
    throw new Error('包含未知的设置项');
  }
  const next = { ...previous, ...updates };
  const validationError = validateSettings(next);
  if (validationError) throw new Error(validationError);
  next.shortcut = next.shortcut.trim();

  const shortcutChanged = next.shortcut !== previous.shortcut;
  // Also retry the same shortcut after a failed startup registration.
  next.shortcut = await writer.registerShortcut(next.shortcut);

  try {
    // One statement is atomic even when the SQL plugin uses a connection pool.
    const placeholders = SETTING_KEYS.map(() => '(?, ?)').join(', ');
    const values = SETTING_KEYS.flatMap(key => [key, String(next[key])]);
    await writer.execute(`INSERT OR REPLACE INTO settings (key, value) VALUES ${placeholders}`, values);
  } catch (error) {
    if (shortcutChanged) {
      try {
        await writer.registerShortcut(previous.shortcut);
      } catch (rollbackError) {
        throw new Error(`设置保存失败，且恢复原快捷键失败；当前快捷键可能仍为 ${next.shortcut}。${String(error)}；${String(rollbackError)}`);
      }
    }
    throw error;
  }
  return next;
}
