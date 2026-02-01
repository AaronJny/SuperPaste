import { useState } from 'react';
import type { Settings } from '../types';

interface Props {
  settings: Settings;
  onUpdateShortcut: (shortcut: string) => Promise<boolean>;
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

function SettingsPanel({ settings, onUpdateShortcut, onUpdateSettings, onClose }: Props) {
  const [shortcut, setShortcut] = useState(settings.shortcut);
  const [maxItems, setMaxItems] = useState(settings.max_items);
  const [maxDays, setMaxDays] = useState(settings.max_days);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const handleSave = async () => {
    setSaving(true);
    setMessage('');

    try {
      if (shortcut !== settings.shortcut) {
        const success = await onUpdateShortcut(shortcut);
        if (!success) {
          setMessage('快捷键设置失败，请尝试其他组合');
          setSaving(false);
          return;
        }
      }

      await onUpdateSettings({
        max_items: maxItems,
        max_days: maxDays,
      });

      setMessage('设置已保存');
      setTimeout(() => onClose(), 1000);
    } catch (e) {
      setMessage('保存失败');
    } finally {
      setSaving(false);
    }
  };

  const formatShortcut = (s: string) => {
    return s
      .replace('CommandOrControl', '⌘')
      .replace('Shift', '⇧')
      .replace('Alt', '⌥')
      .replace(/\+/g, ' + ');
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>设置</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="settings-content">
          <div className="setting-item">
            <label>唤起快捷键</label>
            <select 
              value={shortcut} 
              onChange={e => setShortcut(e.target.value)}
            >
              {SHORTCUT_OPTIONS.map(opt => (
                <option key={opt} value={opt}>
                  {formatShortcut(opt)}
                </option>
              ))}
            </select>
          </div>

          <div className="setting-item">
            <label>最大保存条数</label>
            <input
              type="number"
              min={100}
              max={5000}
              value={maxItems}
              onChange={e => setMaxItems(parseInt(e.target.value) || 1000)}
            />
          </div>

          <div className="setting-item">
            <label>保存天数</label>
            <input
              type="number"
              min={1}
              max={365}
              value={maxDays}
              onChange={e => setMaxDays(parseInt(e.target.value) || 30)}
            />
          </div>
        </div>

        {message && (
          <div className={`settings-message ${message.includes('失败') ? 'error' : 'success'}`}>
            {message}
          </div>
        )}

        <div className="settings-footer">
          <button className="btn-secondary" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SettingsPanel;
