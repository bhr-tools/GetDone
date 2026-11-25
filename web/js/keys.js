// Vim-style keys of Get Done, as tables for the kit (kit/js/keys.js decides
// when keys reach them: not while a dialog is open or a field is typed in).
// The sidebar and the task list have their own table; ? lists the one in
// force, generated from the labels below.

import { initKeys as initKitKeys } from '/kit/js/keys.js';

const nav = (app) => [
  { keys: ['/'], label: 'Search', group: 'Navigation', run: () => app.openSearch() },
  { keys: ['q'], label: 'Quick add to the inbox', group: 'Tasks', run: () => app.openQuickAdd({ inbox: true }) },
];

function sidebarTable(app) {
  return [
    { keys: ['j', 'ArrowDown'], label: 'Next project', group: 'Sidebar', run: () => app.moveSidebarCursor(1) },
    { keys: ['k', 'ArrowUp'], label: 'Previous project', group: 'Sidebar', run: () => app.moveSidebarCursor(-1) },
    { keys: ['J'], label: 'Move project down', group: 'Sidebar', run: () => app.moveSidebarProject('down') },
    { keys: ['K'], label: 'Move project up', group: 'Sidebar', run: () => app.moveSidebarProject('up') },
    { keys: ['L'], label: 'Nest project', group: 'Sidebar', run: () => app.moveSidebarProject('indent') },
    { keys: ['H'], label: 'Un-nest project', group: 'Sidebar', run: () => app.moveSidebarProject('outdent') },
    { keys: ['Enter', 'l', 'ArrowRight', 'Escape'], label: 'Open the project', group: 'Sidebar', run: () => app.setFocus('tasks') },
    { keys: ['h', 'ArrowLeft'], hidden: true, run: () => {} },
    ...nav(app),
  ];
}

function taskTable(app) {
  return [
    { keys: ['j', 'ArrowDown'], label: 'Next task', group: 'Navigation', run: () => app.moveCursor(1) },
    { keys: ['k', 'ArrowUp'], label: 'Previous task', group: 'Navigation', run: () => app.moveCursor(-1) },
    { keys: ['gg'], label: 'First task', group: 'Navigation', run: () => app.moveCursorTo(0) },
    { keys: ['G'], label: 'Last task', group: 'Navigation', run: () => app.moveCursorTo(-1) },
    { keys: ['h', 'ArrowLeft'], label: 'Sidebar', group: 'Navigation', run: () => app.setFocus('sidebar') },
    { keys: ['l', 'ArrowRight'], hidden: true, run: () => app.setFocus('tasks') },
    { keys: ['e', 'Enter'], label: 'Open the task', group: 'Navigation', run: () => app.openCursorDetail() },
    { keys: ['Escape'], label: 'Clear the selection', group: 'Navigation', run: () => app.clearSelection() },
    ...nav(app),
    { keys: ['a'], label: 'Add a task below', group: 'Tasks', run: () => app.addBelowCursor() },
    { keys: ['d'], label: 'Complete', group: 'Tasks', run: () => app.completeTasks(app.targetIds()) },
    { keys: ['u'], label: 'Undo completion', group: 'Tasks', run: () => app.undo() },
    { digit: true, helpKeys: ['1', '2', '3'], label: 'Priority (also & é " on AZERTY)', group: 'Tasks', run: (n) => n >= 1 && n <= 3 && app.setPriority(app.targetIds(), n) },
    { keys: [' '], label: 'Select / unselect (or Ctrl+click, Shift+click)', group: 'Tasks', run: () => app.toggleSelection() },
    { keys: ['t'], label: 'Due date', group: 'Tasks', run: () => app.pickDateForTasks(app.targetIds()) },
    { keys: ['w'], label: 'Location', group: 'Tasks', run: () => app.pickLocationForTasks(app.targetIds()) },
    { keys: ['m'], label: 'Move to project', group: 'Tasks', run: () => app.pickProjectForTasks(app.targetIds()) },
    { keys: ['s'], label: 'Move to section (Upcoming: to a day)', group: 'Tasks', run: () => app.pickSectionForTasks(app.targetIds()) },
    { keys: ['J'], label: 'Move down (manual order)', group: 'Tasks', run: () => app.reorderCursor(1) },
    { keys: ['K'], label: 'Move up (manual order)', group: 'Tasks', run: () => app.reorderCursor(-1) },
    { keys: ['L'], label: 'Make subtask', group: 'Tasks', run: () => app.indentCursor() },
    { keys: ['H'], label: 'Un-nest', group: 'Tasks', run: () => app.outdentCursor() },
    // Listed for the help only: the sidebar's own keys, and those the task
    // details dialog handles itself.
    { keys: ['J', 'K'], label: 'Move project down / up', group: 'Sidebar' },
    { keys: ['L', 'H'], label: 'Nest / un-nest project', group: 'Sidebar' },
    { keys: ['Enter'], label: 'Edit the title', group: 'Task details' },
    { keys: ['a'], label: 'Add a subtask', group: 'Task details' },
    { keys: ['f'], label: 'Attach a file', group: 'Task details' },
    { keys: ['t', 'w'], label: 'Due date / location', group: 'Task details' },
    { keys: ['C-Enter'], label: 'Save the description', group: 'Task details' },
  ];
}

/** The keys in force: the sidebar's or the task list's. */
export function keyTable(app) {
  return app.state.focus === 'sidebar' ? sidebarTable(app) : taskTable(app);
}

export function initKeys(app) {
  initKitKeys({
    table: () => keyTable(app),
    onMode: (insert) => app.renderStatus(insert ? 'INSERT' : null),
  });
}
