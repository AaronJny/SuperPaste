import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useClipboard } from './hooks/useClipboard';
import { useSettings } from './hooks/useSettings';
import ClipboardCard from './components/ClipboardCard';
import SearchBar, { SearchBarRef } from './components/SearchBar';
import SettingsPanel from './components/SettingsPanel';
import type { ClipboardItem } from './types';

function App() {
  const { items, updateItemTime, searchItems, deleteItem } = useClipboard();
  const { settings, updateShortcut, updateSettings } = useSettings();
  
  // 核心状态：-1 表示搜索模式，>=0 表示选中的卡片索引
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  
  const searchBarRef = useRef<SearchBarRef>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  // items 变化时，清理多余的 refs
  useEffect(() => {
    cardRefs.current.length = items.length;
  }, [items.length]);

  // 选中卡片变化时，滚动到可视区域
  useEffect(() => {
    if (selectedIndex >= 0 && cardRefs.current[selectedIndex]) {
      cardRefs.current[selectedIndex]?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center'
      });
    }
  }, [selectedIndex]);

  // 判断是否在搜索模式
  const isSearchMode = () => searchBarRef.current?.isFocused() ?? false;

  // 进入卡片模式
  const enterCardMode = useCallback(() => {
    if (items.length > 0) {
      searchBarRef.current?.blur();
      setSelectedIndex(0);
    }
  }, [items.length]);

  // 返回搜索模式
  const enterSearchMode = useCallback(() => {
    setSelectedIndex(-1);
    searchBarRef.current?.focus();
  }, []);

  // 全局键盘事件处理
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Esc 始终关闭面板
      if (e.key === 'Escape') {
        e.preventDefault();
        await invoke('hide_window');
        return;
      }

      // 搜索框聚焦时，只处理 ArrowDown
      if (isSearchMode()) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          enterCardMode();
        }
        // 其他键（包括 Backspace/Delete）让 input 自然处理
        return;
      }

      // 卡片模式下的键盘操作
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          enterSearchMode();
          break;
          
        case 'ArrowLeft':
          e.preventDefault();
          setSelectedIndex(prev => Math.max(0, prev - 1));
          break;
          
        case 'ArrowRight':
          e.preventDefault();
          setSelectedIndex(prev => Math.min(items.length - 1, prev + 1));
          break;
          
        case 'Enter':
          if (selectedIndex >= 0 && items[selectedIndex]) {
            e.preventDefault();
            await handleCopyAndPaste(items[selectedIndex]);
          }
          break;

        case 'c':
          if (e.metaKey && selectedIndex >= 0 && items[selectedIndex]) {
            e.preventDefault();
            await handleCopy(items[selectedIndex]);
          }
          break;
          
        case 'Backspace':
        case 'Delete':
          if (selectedIndex >= 0 && items[selectedIndex]) {
            e.preventDefault();
            await handleDelete(items[selectedIndex]);
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [items, selectedIndex, enterCardMode, enterSearchMode]);

  // 面板显示时重置状态
  useEffect(() => {
    const unlisten = listen('panel-show', () => {
      setSearchQuery('');
      setSelectedIndex(-1);
      // 等待窗口渲染完成后聚焦
      requestAnimationFrame(() => {
        searchBarRef.current?.focus();
      });
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // 窗口失焦时隐藏
  useEffect(() => {
    const currentWindow = getCurrentWindow();
    const unlisten = currentWindow.onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        invoke('hide_window');
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  const handleCopy = async (item: ClipboardItem) => {
    const content = item.content_type === 'text'
      ? item.text_content!
      : item.image_path!;

    await invoke('copy_to_clipboard', {
      content,
      contentType: item.content_type
    });
    await updateItemTime(item.content_hash);
    await invoke('hide_window');
  };

  // 复制并粘贴（用于回车键和鼠标点击）
  const handleCopyAndPaste = async (item: ClipboardItem) => {
    const content = item.content_type === 'text'
      ? item.text_content!
      : item.image_path!;

    await invoke('copy_to_clipboard', {
      content,
      contentType: item.content_type
    });
    await updateItemTime(item.content_hash);
    await invoke('hide_window');
    // 执行粘贴（延迟在 Rust 端处理）
    try {
      await invoke('paste');
    } catch (e) {
      console.error('Paste failed:', e);
    }
  };

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
    searchItems(query);
  }, [searchItems]);

  const handleDelete = async (item: ClipboardItem) => {
    const newLength = items.length - 1;
    await deleteItem(item);
    
    // 调整选中索引
    if (newLength === 0) {
      enterSearchMode();
    } else if (selectedIndex >= newLength) {
      setSelectedIndex(newLength - 1);
    }
  };

  const handleCardClick = (index: number) => {
    setSelectedIndex(index);
    handleCopyAndPaste(items[index]);
  };

  return (
    <div className="app-container">
      <div className="panel">
        <SearchBar 
          ref={searchBarRef}
          value={searchQuery} 
          onChange={handleSearch}
        />
        
        <div className="cards-container">
          {items.length === 0 ? (
            <div className="empty-state">
              <p>暂无剪贴板记录</p>
              <p className="hint">复制一些内容后会显示在这里</p>
            </div>
          ) : (
            <div className="cards-scroll">
              {items.map((item, index) => (
                <ClipboardCard
                  key={item.id}
                  ref={(el) => { cardRefs.current[index] = el; }}
                  item={item}
                  isSelected={index === selectedIndex}
                  onClick={() => handleCardClick(index)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="footer">
          <span className="hint">↓ 选择卡片</span>
          <span className="hint">← → 切换</span>
          <span className="hint">Enter 复制</span>
          <span className="hint">Delete 删除</span>
          <span className="hint">Esc 关闭</span>
          <button className="settings-btn" onClick={() => setShowSettings(true)}>⚙️</button>
        </div>
      </div>

      {showSettings && (
        <SettingsPanel
          settings={settings}
          onUpdateShortcut={updateShortcut}
          onUpdateSettings={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

export default App;
