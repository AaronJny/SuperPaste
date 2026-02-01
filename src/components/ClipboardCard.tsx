import { forwardRef } from 'react';
import type { ClipboardItem } from '../types';
import { convertFileSrc } from '@tauri-apps/api/core';

interface Props {
  item: ClipboardItem;
  isSelected: boolean;
  onClick: () => void;
}

const ClipboardCard = forwardRef<HTMLDivElement, Props>(
  ({ item, isSelected, onClick }, ref) => {
    const formatTime = (dateStr: string) => {
      const date = new Date(dateStr + 'Z');
      const now = new Date();
      const diff = now.getTime() - date.getTime();
      
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
      return `${Math.floor(diff / 86400000)}天前`;
    };

    const renderContent = () => {
      if (item.content_type === 'image') {
        const src = item.thumbnail_path || item.image_path;
        return (
          <div className="card-image">
            <img 
              src={src ? convertFileSrc(src) : ''} 
              alt="clipboard image" 
            />
          </div>
        );
      }

      return (
        <div className="card-text">
          {item.text_content?.slice(0, 200)}
          {(item.text_content?.length || 0) > 200 && '...'}
        </div>
      );
    };

    return (
      <div 
        ref={ref}
        className={`card ${isSelected ? 'selected' : ''}`}
        onClick={onClick}
      >
        <div className="card-content">
          {renderContent()}
        </div>
        <div className="card-footer">
          <span className="card-type">
            {item.content_type === 'image' ? '🖼️' : '📝'}
          </span>
          <span className="card-time">{formatTime(item.updated_at)}</span>
        </div>
      </div>
    );
  }
);

ClipboardCard.displayName = 'ClipboardCard';

export default ClipboardCard;
