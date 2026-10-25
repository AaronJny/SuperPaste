export type PanelKeyAction = 'close-settings' | 'hide-window' | 'enter-cards' |
  'enter-search' | 'previous' | 'next' | 'copy' | 'paste' | 'delete' | null;

interface PanelKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
}

interface KeyContext {
  settingsOpen: boolean;
  searchFocused: boolean;
  interactiveTarget: boolean;
  hasSelection: boolean;
  hasItems: boolean;
}

/** Form controls own their keys, including Enter on buttons and editable descendants. */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="button"]'));
}

export function getPanelKeyAction(event: PanelKeyEvent, context: KeyContext): PanelKeyAction {
  if (event.defaultPrevented || event.isComposing) return null;
  if (context.settingsOpen) return event.key === 'Escape' ? 'close-settings' : null;
  if (event.key === 'Escape') return 'hide-window';
  if (context.searchFocused) {
    return event.key === 'ArrowDown' && !event.altKey && !event.metaKey && !event.ctrlKey && context.hasItems
      ? 'enter-cards' : null;
  }
  if (context.interactiveTarget) return null;
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c') {
    return context.hasSelection && !event.repeat ? 'copy' : null;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  switch (event.key) {
    case 'ArrowUp': return 'enter-search';
    case 'ArrowDown': return context.hasItems ? 'enter-cards' : null;
    case 'ArrowLeft': return context.hasItems ? 'previous' : null;
    case 'ArrowRight': return context.hasItems ? 'next' : null;
    case 'Enter': return context.hasSelection && !event.repeat ? 'paste' : null;
    case 'Backspace':
    case 'Delete': return context.hasSelection && !event.repeat ? 'delete' : null;
    default: return null;
  }
}
