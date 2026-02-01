import { useRef, useImperativeHandle, forwardRef } from 'react';

interface Props {
  value: string;
  onChange: (value: string) => void;
}

export interface SearchBarRef {
  focus: () => void;
  blur: () => void;
  isFocused: () => boolean;
}

const SearchBar = forwardRef<SearchBarRef, Props>(({ value, onChange }, ref) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    blur: () => inputRef.current?.blur(),
    isFocused: () => document.activeElement === inputRef.current,
  }));

  return (
    <div className="search-bar">
      <span className="search-icon">🔍</span>
      <input
        ref={inputRef}
        type="text"
        placeholder="搜索剪贴板..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
});

export default SearchBar;
