import type { KeyboardEvent } from 'react';

/** Shared keyboard-navigation handler for `role="listbox"` containers whose children are `role="option"` rows. */
export function onListKeyDown(e: KeyboardEvent<HTMLElement>): void {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]');
  if (!row) return;
  const options = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
  const index = options.indexOf(row);
  if (index < 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    options[Math.min(index + 1, options.length - 1)].focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    options[Math.max(index - 1, 0)].focus();
  } else if (e.key === 'Home') {
    e.preventDefault();
    options[0].focus();
  } else if (e.key === 'End') {
    e.preventDefault();
    options[options.length - 1].focus();
  } else if ((e.key === 'Enter' || e.key === ' ') && e.target === row) {
    e.preventDefault();
    row.click();
  } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
  }
}
