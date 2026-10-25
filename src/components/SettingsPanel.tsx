import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../types';
import { SETTINGS_LIMITS, validateSettings } from '../utils/settings';

interface Props {
  settings: Settings;
  error?: string | null;
  onUpdateSettings: (updates: Partial<Settings>) => Promise<boolean>;
  onClose: () => void;
}

const SHORTCUT_OPTIONS = [
  'CommandOrControl+Shift+V',
  'CommandOrControl+Shift+C',
  'CommandOrControl+Alt+V',
  'CommandOrControl+Alt+C',
  'CommandOrControl+Shift+P',
];

function SettingsPanel({ settings, error, onUpdateSettings, onClose }: Props) {
  const [shortcut, setShortcut] = useState(settings.shortcut);
  const [maxItems, setMaxItems] = useState(String(settings.max_items));
  const [maxDays, setMaxDays] = useState(String(settings.max_days));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const previousFocus = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>('select')?.focus();
    return () => {
      mountedRef.current = false;
      previousFocus?.focus();
    };
  }, []);

  const handleSave = async () => {
    if (savingRef.current) return;
    const next: Settings = {
      shortcut,
      max_items: Number(maxItems),
      max_days: Number(maxDays),
      max_file_size_mb: settings.max_file_size_mb,
    };
    const validationError = validateSettings(next);
    if (validationError) {
      setMessage({ text: validationError, success: false });
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setMessage(null);
    try {
      // All fields, including the shortcut, are saved by a single atomic operation.
      const success = await onUpdateSettings(next);
      if (mountedRef.current) {
        setMessage({ text: success ? '设置已保存' : '保存失败，请检查错误后重试', success });
      }
    } catch (cause) {
      if (mountedRef.current) setMessage({ text: `保存失败：${String(cause)}`, success: false });
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const close = () => { if (!savingRef.current) onClose(); };
  const edit = (update: () => void) => { setMessage(null); update(); };
  const formatShortcut = (value: string) => value.replace('CommandOrControl', 'Cmd/Ctrl').replace(/\+/g, ' + ');
  const shortcutOptions = SHORTCUT_OPTIONS.includes(shortcut) ? SHORTCUT_OPTIONS : [shortcut, ...SHORTCUT_OPTIONS];

  return (
    <div className="settings-overlay" onClick={close}>
      <div
        className="settings-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        aria-busy={saving}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          // The modal owns every key; none may reach clipboard-card actions.
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          } else if (event.key === 'Tab') {
            const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []);
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="settings-header">
          <h2 id="settings-title">设置</h2>
          <button className="close-btn" aria-label="关闭设置" disabled={saving} onClick={close}>✕</button>
        </div>

        <div className="settings-content">
          <div className="setting-item">
            <label htmlFor="shortcut">唤起快捷键</label>
            <select id="shortcut" value={shortcut} disabled={saving} onChange={event => edit(() => setShortcut(event.target.value))}>
              {shortcutOptions.map(option => <option key={option} value={option}>{formatShortcut(option)}</option>)}
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="max-items">最大保存条数</label>
            <input id="max-items" type="number" min={SETTINGS_LIMITS.max_items.min} max={SETTINGS_LIMITS.max_items.max} step={1} required disabled={saving} value={maxItems} onChange={event => edit(() => setMaxItems(event.target.value))} />
          </div>
          <div className="setting-item">
            <label htmlFor="max-days">保存天数</label>
            <input id="max-days" type="number" min={SETTINGS_LIMITS.max_days.min} max={SETTINGS_LIMITS.max_days.max} step={1} required disabled={saving} value={maxDays} onChange={event => edit(() => setMaxDays(event.target.value))} />
          </div>
        </div>

        {error && <div className="settings-message error" role="alert">{error}</div>}
        {message && <div className={`settings-message ${message.success ? 'success' : 'error'}`} role={message.success ? 'status' : 'alert'}>{message.text}</div>}

        <div className="settings-footer">
          <button className="btn-secondary" disabled={saving} onClick={close}>关闭</button>
          <button className="btn-primary" disabled={saving} onClick={handleSave}>{saving ? '保存中...' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}

export default SettingsPanel;
