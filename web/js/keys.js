// Vim-style keyboard control. One window-level handler decides, in order:
//   1. Escape closes the topmost popover or dialog;
//   2. while a dialog is open, other keys belong to it;
//   3. while typing in a field (INSERT mode), keys belong to the field;
//   4. otherwise keys are commands for the sidebar or the task list.
// Components that handle a key themselves call preventDefault(), and this
// handler then ignores it.

import { escapeTopLayer, topModal, isPopoverOpen } from './ui/overlay.js';
import { isTextInput } from './dom.js';

// AZERTY keyboards type these characters on the 1, 2 and 3 keys.
const PRIORITY_KEYS = { 1: 1, '&': 1, 2: 2, 'é': 2, 3: 3, '"': 3 };

export function initKeys(app) {
  let pendingG = 0;

  const updateMode = () => app.renderStatus(isTextInput(document.activeElement) ? 'INSERT' : null);
  document.addEventListener('focusin', updateMode);
  document.addEventListener('focusout', () => setTimeout(updateMode, 0));

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;

    if (e.key === 'Escape') {
      if (escapeTopLayer()) {
        e.preventDefault();
        return;
      }
      if (isTextInput(document.activeElement)) {
        e.preventDefault();
        document.activeElement.blur();
        return;
      }
    }
    if (topModal() || isPopoverOpen() || isTextInput(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const key = e.key;
    const handled = app.state.focus === 'sidebar' ? sidebarKey(key) : taskKey(key);
    if (handled) e.preventDefault();
  });

  function sidebarKey(key) {
    switch (key) {
      case 'j': case 'ArrowDown': app.moveSidebarCursor(1); return true;
      case 'k': case 'ArrowUp': app.moveSidebarCursor(-1); return true;
      case 'J': app.moveSidebarProject('down'); return true;
      case 'K': app.moveSidebarProject('up'); return true;
      case 'L': app.moveSidebarProject('indent'); return true;
      case 'H': app.moveSidebarProject('outdent'); return true;
      case 'Enter': case 'l': case 'ArrowRight': case 'Escape': app.setFocus('tasks'); return true;
      case 'h': case 'ArrowLeft': return true;
      case '/': app.openSearch(); return true;
      case 'q': app.openQuickAdd({ inbox: true }); return true;
      case '?': app.openHelp(); return true;
    }
    return false;
  }

  function taskKey(key) {
    if (key === 'g') {
      if (Date.now() - pendingG < 1000) {
        pendingG = 0;
        app.moveCursorTo(0);
      } else {
        pendingG = Date.now();
      }
      return true;
    }
    pendingG = 0;
    if (key in PRIORITY_KEYS) {
      app.setPriority(app.targetIds(), PRIORITY_KEYS[key]);
      return true;
    }
    switch (key) {
      case 'j': case 'ArrowDown': app.moveCursor(1); return true;
      case 'k': case 'ArrowUp': app.moveCursor(-1); return true;
      case 'G': app.moveCursorTo(-1); return true;
      case 'J': app.reorderCursor(1); return true;
      case 'K': app.reorderCursor(-1); return true;
      case 'L': app.indentCursor(); return true;
      case 'H': app.outdentCursor(); return true;
      case 'h': case 'ArrowLeft': app.setFocus('sidebar'); return true;
      case 'l': case 'ArrowRight': app.setFocus('tasks'); return true;
      case 'a': app.addBelowCursor(); return true;
      case 'd': app.completeTasks(app.targetIds()); return true;
      case 'u': app.undo(); return true;
      case ' ': app.toggleSelection(); return true;
      case 'm': app.pickProjectForTasks(app.targetIds()); return true;
      case 's': app.pickSectionForTasks(app.targetIds()); return true;
      case 'e': case 'Enter': app.openCursorDetail(); return true;
      case '/': app.openSearch(); return true;
      case 'q': app.openQuickAdd({ inbox: true }); return true;
      case '?': app.openHelp(); return true;
      case 'Escape': app.clearSelection(); return true;
    }
    return false;
  }
}
