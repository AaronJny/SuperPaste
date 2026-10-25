import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useClipboard } from './hooks/useClipboard';
import { useSettings } from './hooks/useSettings';
import ClipboardCard from './components/ClipboardCard';
import SearchBar, { SearchBarRef } from './components/SearchBar';
import SettingsPanel from './components/SettingsPanel';
import { getPanelKeyAction, isInteractiveTarget } from './utils/keyboard';
import type { ClipboardItem } from './types';

function App() {
  const { settings, loading, historyReady, error: settingsError, updateSettings } = useSettings();
  const { items, updateItemTime, searchItems, deleteItem, error: clipboardError } = useClipboard(settings, historyReady);
  // Keep selection attached to an item, not an index that changes after a refresh.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [panelShowVersion, setPanelShowVersion] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actionPending = useRef(false);
  const selectedIndex = items.findIndex(item => item.id === selectedId);
  const searchBarRef = useRef<SearchBarRef>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const searchItemsRef = useRef(searchItems);
  searchItemsRef.current = searchItems;

  const enterSearchMode = useCallback(() => {
    setSelectedId(null);
    searchBarRef.current?.focus();
  }, []);

  useEffect(() => {
    cardRefs.current.length = items.length;
    if (selectedId !== null && selectedIndex < 0 && !busy) {
      setSelectedId(null);
      if (!showSettings) searchBarRef.current?.focus();
    }
  }, [items.length, selectedId, selectedIndex, showSettings, busy]);

  useEffect(() => {
    if (selectedIndex >= 0) {
      cardRefs.current[selectedIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [selectedIndex]);

  const runAction = useCallback(async (operation: () => Promise<void>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await operation();
    } catch (cause) {
      setActionError(String(cause));
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }, []);

  const copyItem = useCallback((item: ClipboardItem, paste: boolean) => runAction(async () => {
    const content = item.content_type === 'text' ? item.text_content : item.image_path;
    if (content === null || content === undefined) throw new Error('此记录缺少可复制的内容');
    await invoke('copy_to_clipboard', { content, contentType: item.content_type });
    // A metadata failure must not turn a successful clipboard write into a silent failure.
    try {
      await updateItemTime(item.content_hash);
    } catch (cause) {
      throw new Error(`内容已复制，但更新历史记录失败；尚未自动粘贴：${String(cause)}`);
    }
    if (paste) {
      // Hide restores the target application's focus; the backend delays the paste.
      await invoke('hide_window');
      try {
        await invoke('paste');
      } catch (cause) {
        throw new Error(`内容已复制，但自动粘贴失败，可手动粘贴：${String(cause)}`);
      }
    } else {
      await invoke('hide_window');
    }
  }), [runAction, updateItemTime]);

  const handleDelete = useCallback((item: ClipboardItem) => runAction(async () => {
    const index = items.findIndex(candidate => candidate.id === item.id);
    const nextId = items[index + 1]?.id ?? items[index - 1]?.id ?? null;
    await deleteItem(item);
    // Do not move a newer selection made while deletion was in flight.
    setSelectedId(current => current === item.id ? nextId : current);
    if (nextId === null) searchBarRef.current?.focus();
  }), [deleteItem, items, runAction]);

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
    setSelectedId(null);
    void searchItems(query).catch(cause => setActionError(`搜索失败：${String(cause)}`));
  }, [searchItems]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = getPanelKeyAction(event, {
        settingsOpen: showSettings,
        searchFocused: searchBarRef.current?.isFocused() ?? false,
        interactiveTarget: isInteractiveTarget(event.target),
        hasSelection: selectedIndex >= 0,
        hasItems: items.length > 0,
      });
      if (!action) return;
      event.preventDefault();
      switch (action) {
        case 'close-settings': setShowSettings(false); break;
        case 'hide-window': void runAction(() => invoke('hide_window')); break;
        case 'enter-search': enterSearchMode(); break;
        case 'enter-cards':
          searchBarRef.current?.blur();
          setSelectedId(items[0].id);
          break;
        case 'previous': setSelectedId(items[Math.max(0, selectedIndex - 1)].id); break;
        case 'next': setSelectedId(items[Math.min(items.length - 1, selectedIndex + 1)].id); break;
        case 'copy': void copyItem(items[selectedIndex], false); break;
        case 'paste': void copyItem(items[selectedIndex], true); break;
        case 'delete': void handleDelete(items[selectedIndex]); break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [items, selectedIndex, showSettings, runAction, enterSearchMode, copyItem, handleDelete]);

  useEffect(() => {
    let disposed = false;
    const unlisten = listen('panel-show', () => {
      setSearchQuery('');
      setSelectedId(null);
      setShowSettings(false);
      setPanelShowVersion(version => version + 1);
      // Reset the hook's filter too, not just the text displayed in the search box.
      void searchItemsRef.current('').catch(cause => setActionError(`加载记录失败：${String(cause)}`));
    });
    void unlisten.catch(cause => { if (!disposed) setActionError(`无法监听窗口显示事件：${String(cause)}`); });
    return () => {
      disposed = true;
      void unlisten.then(stop => stop(), () => undefined);
    };
  }, []);

  useEffect(() => {
    // Focus after React commits the reopen and runs SettingsPanel's unmount
    // cleanup. Focusing in the native event/animation frame can run first and
    // then be overwritten when the dialog restores its previous button focus.
    if (panelShowVersion > 0) searchBarRef.current?.focus();
  }, [panelShowVersion]);

  useEffect(() => {
    let disposed = false;
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        // Native popup focus is not an application switch. The backend checks
        // the current owner before dismissing, without restoring stale focus.
        void invoke('hide_window_on_blur').catch(cause => {
          if (!disposed) setActionError(`隐藏窗口失败：${String(cause)}`);
        });
      }
    });
    void unlisten.catch(cause => { if (!disposed) setActionError(`无法监听窗口焦点：${String(cause)}`); });
    return () => { disposed = true; void unlisten.then(stop => stop(), () => undefined); };
  }, []);

  return (
    <div className="app-container" aria-busy={busy || loading}>
      <div className="panel" aria-hidden={showSettings || undefined}>
        <SearchBar ref={searchBarRef} value={searchQuery} onChange={handleSearch} />
        {(settingsError || clipboardError || actionError) && (
          <div className="settings-message error" role="alert">
            {[settingsError, clipboardError, actionError].filter(Boolean).join('。')}
            {actionError && <button onClick={() => setActionError(null)} aria-label="关闭操作错误">✕</button>}
          </div>
        )}
        <div className="cards-container">
          {items.length === 0 ? (
            <div className="empty-state">
              <p>{loading ? '正在加载设置…' : searchQuery ? '没有匹配的记录' : '暂无剪贴板记录'}</p>
              <p className="hint">{searchQuery ? '试试其他关键词，或清空搜索' : '复制一些内容后会显示在这里'}</p>
            </div>
          ) : (
            <div className="cards-scroll">
              {items.map((item, index) => (
                <ClipboardCard key={item.id} ref={element => { cardRefs.current[index] = element; }} item={item} isSelected={index === selectedIndex} onClick={() => {
                  if (actionPending.current || showSettings) return;
                  setSelectedId(item.id);
                  void copyItem(item, true);
                }} />
              ))}
            </div>
          )}
        </div>
        <div className="footer">
          <span className="hint">↓ 选择卡片</span>
          <span className="hint">← → 切换</span>
          <span className="hint">Enter 复制并粘贴</span>
          <span className="hint">Cmd/Ctrl+C 复制</span>
          <span className="hint">Delete 删除</span>
          <span className="hint">Esc 关闭</span>
          <button className="settings-btn" aria-label="打开设置" disabled={loading || busy} onClick={() => setShowSettings(true)}>⚙️</button>
        </div>
      </div>
      {showSettings && <SettingsPanel settings={settings} error={settingsError} onUpdateSettings={updateSettings} onClose={() => setShowSettings(false)} />}
    </div>
  );
}

export default App;
