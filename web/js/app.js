// Get Done web app: state, actions and orchestration of the views.

import { api, ApiError, onUnauthorized } from './api.js';
import { h, icon, isMobile } from './dom.js';
import { todayISO, splitDue, withDate, addDays, parseISO, WEEKDAYS_SHORT, MONTHS_SHORT } from './dates.js';
import { openModal, closeAllModals, closePopover, confirmDialog, promptDialog, openMenu, toast, topModal } from './ui/overlay.js';
import { openPicker } from './ui/picker.js';
import { createComposer } from './views/composer.js';
import { renderTasks, renderWeekStrip } from './views/tasks.js';
import { renderSidebar, sidebarRows } from './views/sidebar.js';
import { TaskDetail } from './views/detail.js';
import { initDragAndDrop } from './dnd.js';
import { initKeys } from './keys.js';

const SORT_LABELS = { manual: 'Manual order', date: 'Due date', priority: 'Priority', title: 'Alphabetical' };
const UNDO_LIMIT = 50;
const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.state = {
      auth: { no_auth: false, has_password: true, authenticated: false },
      view: 'inbox',          // inbox | upcoming | project
      projectId: null,
      projects: [],           // tree, without the inbox
      inboxSort: 'manual',
      sections: [],           // sections of the current project
      tasks: [],              // tasks of the current view (tree, or flat for upcoming)
      counts: { inbox: 0, upcoming: 0, projects: {} },
      cursorId: null,         // task under the keyboard cursor
      selection: new Set(),   // tasks selected with Space
      focus: 'tasks',         // tasks | sidebar
      sidebarIndex: 0,
      today: todayISO(),
    };
    this.order = [];          // tasks in display order
    this.lists = new Map();   // list key -> element, for the inline composer
    this.cursorIndex = 0;
    this.undoStack = [];
    this.composer = null;     // { el, key, target, afterId }
    this.loadId = 0;
    this.detail = new TaskDetail(this);
  }

  async start() {
    this.bindChrome();
    initKeys(this);
    initDragAndDrop(this);
    onUnauthorized(() => this.showLogin());
    // Follow the calendar when the app stays open past midnight.
    const checkDay = () => {
      if (todayISO() !== this.state.today && this.state.auth.authenticated) this.refresh();
    };
    setInterval(checkDay, 60_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkDay();
    });
    await this.boot();
  }

  async boot() {
    let status;
    try {
      status = await api.auth.status();
    } catch (err) {
      this.showFatal(err);
      return;
    }
    this.state.auth = status;
    $('auth-menu').hidden = status.no_auth;
    if (!status.no_auth && !status.has_password) return this.showSetup();
    if (!status.authenticated) return this.showLogin();
    await this.loadProjects();
    await this.switchView('inbox');
  }

  // -------------------------------------------------------------------------
  // Loading and rendering
  // -------------------------------------------------------------------------

  async loadProjects() {
    try {
      const [projects, inbox] = await Promise.all([api.projects.list(), api.projects.get('inbox')]);
      this.state.projects = projects;
      this.state.inboxSort = inbox.sort_by;
    } catch (err) {
      this.reportError(err);
    }
  }

  async switchView(view, projectId = null, { keepFocus = false } = {}) {
    const s = this.state;
    this.closeInlineComposer();
    s.view = view;
    s.projectId = view === 'project' ? projectId : null;
    s.cursorId = null;
    this.cursorIndex = 0;
    s.selection.clear();
    if (!keepFocus) s.focus = 'tasks';
    if (!keepFocus) this.closeSidebar();
    s.tasks = [];
    s.sections = [];
    await this.refresh();
    $('main').scrollTop = 0;
  }

  /** Reloads the current view and the sidebar counts. */
  async refresh() {
    const s = this.state;
    const id = ++this.loadId;
    s.today = todayISO();
    try {
      const [tasks, counts, sections] = await Promise.all([
        api.tasks.list(s.view, { projectId: s.projectId || '', sort: this.currentSort() }),
        api.counts(),
        s.view === 'project' ? api.sections.list(s.projectId) : [],
      ]);
      if (id !== this.loadId) return; // a newer refresh superseded this one
      Object.assign(s, { tasks, counts, sections });
      this.render();
    } catch (err) {
      if (id !== this.loadId) return;
      if (err.status === 404 && s.view === 'project') {
        await this.loadProjects();
        await this.switchView('inbox');
        return;
      }
      this.reportError(err);
    }
  }

  render() {
    const s = this.state;
    renderSidebar(this, $('nav'), $('project-tree'));
    this.renderHeader();
    const strip = $('week-strip');
    strip.hidden = s.view !== 'upcoming';
    if (s.view === 'upcoming') renderWeekStrip(this, strip);
    const { order, lists } = renderTasks(this, $('tasks'));
    this.order = order;
    this.lists = lists;
    this.placeComposer();
    if (s.cursorId && !order.some((t) => t.id === s.cursorId)) s.cursorId = null;
    if (!s.cursorId && order.length) s.cursorId = order[Math.min(this.cursorIndex, order.length - 1)].id;
    for (const id of [...s.selection]) if (!order.some((t) => t.id === id)) s.selection.delete(id);
    this.renderCursor(false);
    this.renderSidebarCursor();
  }

  renderHeader() {
    const s = this.state;
    const project = s.view === 'project' ? this.findProject(s.projectId) : null;
    $('view-title').textContent = s.view === 'upcoming' ? 'Upcoming' : project ? project.name : 'Inbox';
    document.title = `${$('view-title').textContent} · Get Done`;
    $('sort-button').hidden = s.view === 'upcoming';
    $('sort-label').textContent = SORT_LABELS[this.currentSort()];
    $('add-section').hidden = s.view !== 'project';
    $('delete-project').hidden = s.view !== 'project';
  }

  renderCursor(scroll = true) {
    const s = this.state;
    const area = $('tasks');
    for (const row of area.querySelectorAll('.task-row.cursor')) row.classList.remove('cursor');
    const index = this.order.findIndex((t) => t.id === s.cursorId);
    if (index >= 0) this.cursorIndex = index;
    const row = s.cursorId ? area.querySelector(`.task-row[data-id="${CSS.escape(s.cursorId)}"]`) : null;
    if (row && s.focus === 'tasks') {
      row.classList.add('cursor');
      if (scroll) row.scrollIntoView({ block: 'nearest' });
    }
    for (const r of area.querySelectorAll('.task-row')) r.classList.toggle('selected', s.selection.has(r.dataset.id));
    this.renderStatus();
  }

  renderSidebarCursor() {
    const rows = sidebarRows();
    for (const r of rows) r.classList.remove('cursor');
    $('sidebar').classList.toggle('keyboard', this.state.focus === 'sidebar');
    if (this.state.focus !== 'sidebar') return;
    const row = rows[Math.min(this.state.sidebarIndex, rows.length - 1)];
    row?.classList.add('cursor');
    row?.scrollIntoView({ block: 'nearest' });
  }

  /** Updates the status bar. mode: 'INSERT' while typing, else derived. */
  renderStatus(mode = null) {
    const s = this.state;
    const label = mode || (s.selection.size ? `VISUAL (${s.selection.size})` : s.focus === 'sidebar' ? 'SIDEBAR' : 'NORMAL');
    const modeEl = $('status-mode');
    modeEl.textContent = `-- ${label} --`;
    modeEl.className = `status-mode ${label.split(' ')[0].toLowerCase()}`;
    const index = this.order.findIndex((t) => t.id === s.cursorId);
    $('status-position').textContent = `${index >= 0 ? index + 1 : 0} / ${this.order.length}`;
  }

  currentSort() {
    const s = this.state;
    if (s.view === 'inbox') return s.inboxSort;
    if (s.view === 'project') return this.findProject(s.projectId)?.sort_by || 'manual';
    return 'manual';
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  findProject(id, list = this.state.projects) {
    for (const p of list) {
      if (p.id === id) return p;
      const found = this.findProject(id, p.children || []);
      if (found) return found;
    }
    return null;
  }

  /** All projects, depth-first, with their depth. */
  flatProjects(list = this.state.projects, depth = 0, out = []) {
    for (const p of list) {
      out.push({ project: p, depth });
      this.flatProjects(p.children || [], depth + 1, out);
    }
    return out;
  }

  projectSiblings(parentId) {
    return parentId ? this.findProject(parentId)?.children || [] : this.state.projects;
  }

  findTask(id, list = this.state.tasks) {
    for (const t of list) {
      if (t.id === id) return t;
      const found = this.findTask(id, t.subtasks || []);
      if (found) return found;
    }
    return null;
  }

  /** Tasks displayed next to `task` in the same list, in display order. */
  siblingsOf(task) {
    if (this.state.view === 'upcoming') return [];
    if (task.parent_id) {
      const parent = this.findTask(task.parent_id);
      if (parent) return parent.subtasks;
    }
    return this.state.tasks.filter((t) => !t.parent_id || !this.findTask(t.parent_id))
      .filter((t) => (t.section_id || null) === (task.section_id || null));
  }

  async sectionsOf(projectId) {
    if (projectId === this.state.projectId) return this.state.sections;
    try {
      return await api.sections.list(projectId);
    } catch (err) {
      this.reportError(err);
      return [];
    }
  }

  cursorTask() {
    return this.state.cursorId ? this.findTask(this.state.cursorId) : null;
  }

  /** Tasks targeted by a command: the selection, or the task under the cursor. */
  targetIds() {
    const s = this.state;
    if (s.selection.size) return this.order.filter((t) => s.selection.has(t.id)).map((t) => t.id);
    return s.cursorId ? [s.cursorId] : [];
  }

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  reportError(err) {
    if (!(err instanceof ApiError)) console.error(err);
    if (err instanceof ApiError && err.status === 401) return; // the login dialog is shown
    toast(err.message || 'Something went wrong', { type: 'error' });
  }

  /** Runs an async action, reporting failures. Returns its result or undefined. */
  async run(action) {
    try {
      return await action();
    } catch (err) {
      this.reportError(err);
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Keyboard cursor and selection
  // -------------------------------------------------------------------------

  setFocus(area) {
    const s = this.state;
    if (area === 'sidebar') {
      const rows = sidebarRows();
      const active = rows.findIndex((r) => r.classList.contains('active'));
      s.sidebarIndex = Math.max(0, active);
    }
    s.focus = area;
    this.renderCursor();
    this.renderSidebarCursor();
  }

  moveCursor(delta) {
    if (!this.order.length) return;
    const index = this.order.findIndex((t) => t.id === this.state.cursorId);
    const next = Math.max(0, Math.min(this.order.length - 1, (index < 0 ? 0 : index + delta)));
    this.state.cursorId = this.order[next].id;
    this.renderCursor();
  }

  moveCursorTo(index) {
    if (!this.order.length) return;
    this.state.cursorId = this.order.at(index).id;
    this.renderCursor();
  }

  toggleSelection() {
    const s = this.state;
    if (!s.cursorId) return;
    if (s.selection.has(s.cursorId)) s.selection.delete(s.cursorId);
    else s.selection.add(s.cursorId);
    this.moveCursor(1);
    this.renderCursor();
  }

  clearSelection() {
    this.state.selection.clear();
    this.renderCursor(false);
  }

  openCursorDetail() {
    const t = this.cursorTask();
    if (t) this.openDetail(t.id);
  }

  openDetail(id) {
    this.state.cursorId = id;
    this.renderCursor(false);
    this.detail.open(id);
  }

  moveSidebarCursor(delta) {
    const rows = sidebarRows();
    const s = this.state;
    s.sidebarIndex = Math.max(0, Math.min(rows.length - 1, s.sidebarIndex + delta));
    const row = rows[s.sidebarIndex];
    this.renderSidebarCursor();
    if (!row) return;
    // Moving in the sidebar previews the view, like the original app.
    const view = row.dataset.nav;
    if (view === 'project') this.switchView('project', row.dataset.id, { keepFocus: true });
    else this.switchView(view, null, { keepFocus: true });
  }

  // -------------------------------------------------------------------------
  // Task actions
  // -------------------------------------------------------------------------

  async completeTasks(ids) {
    if (!ids.length) return;
    const items = [];
    for (const id of ids) {
      try {
        const result = await api.tasks.complete(id);
        items.push(result);
      } catch (err) {
        if (err.status !== 404) this.reportError(err); // 404: removed with its parent
      }
    }
    this.state.selection.clear();
    if (!items.length) return;
    this.undoStack.push(items);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    const recurring = items.filter((c) => !c.deleted);
    let message = items.length === 1 ? 'Task completed' : `${items.length} tasks completed`;
    if (items.length === 1 && recurring.length === 1) {
      message = `Next occurrence: ${this.dueText(recurring[0].task.due_date)}`;
    }
    toast(message, { action: { label: 'Undo', run: () => this.undo() } });
    await this.refresh();
  }

  dueText(due) {
    const { date, time } = splitDue(due);
    const d = parseISO(date);
    if (!d) return due;
    return `${WEEKDAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}${time ? ` ${time}` : ''}`;
  }

  async undo() {
    const items = this.undoStack.pop();
    if (!items) {
      toast('Nothing to undo');
      return;
    }
    const trees = items.filter((c) => c.deleted).map((c) => c.task);
    const updates = items.filter((c) => !c.deleted).map((c) => ({ id: c.task.id, due_date: c.previous_due_date }));
    const ok = await this.run(() => api.tasks.restore(trees, updates));
    if (ok === undefined) {
      this.undoStack.push(items); // keep it to try again
      return;
    }
    toast(items.length === 1 ? `Restored "${items[0].task.title}"` : `Restored ${items.length} tasks`, { type: 'success' });
    this.state.cursorId = items[0].task.id;
    await this.refresh();
  }

  async setPriority(ids, priority) {
    if (!ids.length) return;
    for (const id of ids) {
      if (await this.run(() => api.tasks.update(id, { priority })) === undefined) break;
    }
    await this.refresh();
  }

  /**
   * Moves tasks one after the other. target is a move request (see
   * api.tasks.move); with several tasks, each lands after the previous one.
   */
  async moveTasks(ids, target) {
    let placement = { before_id: target.before_id, after_id: target.after_id };
    for (const id of ids) {
      const moved = await this.run(() => api.tasks.move(id, { ...target, ...placement }));
      if (!moved) break;
      if (placement.before_id || placement.after_id) placement = { after_id: moved.id };
    }
    this.state.selection.clear();
    await this.refresh();
  }

  async rescheduleTasks(ids, date) {
    // Changing a task's day shifts its subtasks by as many days: update parents
    // first so that subtasks end up on `date` too.
    const depth = (id) => {
      let n = 0;
      for (let t = this.findTask(id); t?.parent_id; t = this.findTask(t.parent_id)) n++;
      return n;
    };
    ids = [...ids].sort((a, b) => depth(a) - depth(b));
    for (const id of ids) {
      const task = this.findTask(id);
      if (await this.run(() => api.tasks.update(id, { due_date: withDate(task?.due_date, date) })) === undefined) break;
    }
    this.state.selection.clear();
    await this.refresh();
  }

  canReorder() {
    if (this.state.view === 'upcoming') {
      toast('Upcoming tasks are ordered by date. Drop a task on a day to reschedule it.');
      return false;
    }
    if (this.currentSort() !== 'manual') {
      toast(`Sorted by ${SORT_LABELS[this.currentSort()].toLowerCase()}: switch to manual order to reorder tasks.`);
      return false;
    }
    return true;
  }

  /** Shift+J / Shift+K: swaps the task with its next / previous sibling. */
  reorderCursor(delta) {
    const task = this.cursorTask();
    if (!task || !this.canReorder()) return;
    const siblings = this.siblingsOf(task);
    const index = siblings.findIndex((t) => t.id === task.id);
    const neighbor = siblings[index + delta];
    if (!neighbor) return;
    this.moveTasks([task.id], {
      project_id: task.project_id, section_id: task.section_id, parent_id: task.parent_id,
      ...(delta > 0 ? { after_id: neighbor.id } : { before_id: neighbor.id }),
    });
  }

  /** Shift+L: makes the task a subtask of the task above it. */
  indentCursor() {
    const task = this.cursorTask();
    if (!task) return;
    if (this.state.view === 'upcoming') {
      toast('Subtasks are arranged in the inbox or project views.');
      return;
    }
    const siblings = this.siblingsOf(task);
    const above = siblings[siblings.findIndex((t) => t.id === task.id) - 1];
    if (above) this.moveTasks([task.id], { parent_id: above.id });
  }

  /** Shift+H: moves a subtask up one level, right after its parent. */
  outdentCursor() {
    const task = this.cursorTask();
    if (!task?.parent_id || this.state.view === 'upcoming') return;
    const parent = this.findTask(task.parent_id);
    if (!parent) return;
    this.moveTasks([task.id], {
      project_id: parent.project_id, section_id: parent.section_id, parent_id: parent.parent_id, after_id: parent.id,
    });
  }

  pickProjectForTasks(ids) {
    if (!ids.length) return;
    openPicker({
      placeholder: 'Move to project…',
      items: (q) => [{ id: 'inbox', name: 'Inbox' }, ...this.flatProjects().map((x) => x.project)]
        .filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
        .map((p) => ({
          label: p.name, icon: p.id === 'inbox' ? 'inbox' : 'hash', badge: 'Project',
          run: async () => {
            await this.moveTasks(ids, { project_id: p.id, section_id: null });
            toast(`${ids.length === 1 ? 'Task' : `${ids.length} tasks`} moved to ${p.name}`);
          },
        })),
    });
  }

  pickSectionForTasks(ids) {
    if (!ids.length) return;
    const s = this.state;
    if (s.view === 'inbox') {
      toast('The inbox has no sections. Use m to move tasks to a project.');
      return;
    }
    let choices;
    if (s.view === 'upcoming') {
      choices = Array.from({ length: 7 }, (_, i) => {
        const iso = addDays(s.today, i);
        const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : this.dueText(iso);
        return { label, icon: 'calendar', badge: 'Day', run: () => this.rescheduleTasks(ids, iso) };
      });
    } else {
      choices = [{ label: 'No section', icon: 'folder', badge: 'Section', run: () => this.moveTasks(ids, { project_id: s.projectId, section_id: null }) },
        ...s.sections.map((sec) => ({ label: sec.name, icon: 'folder', badge: 'Section', run: () => this.moveTasks(ids, { project_id: s.projectId, section_id: sec.id }) }))];
    }
    openPicker({
      placeholder: s.view === 'upcoming' ? 'Reschedule to…' : 'Move to section…',
      items: (q) => choices.filter((c) => c.label.toLowerCase().includes(q.toLowerCase())),
    });
  }

  // -------------------------------------------------------------------------
  // Adding tasks
  // -------------------------------------------------------------------------

  /** Builds a create request from composer fields and a list target. */
  taskRequest(fields, target) {
    const request = { ...fields };
    if (target.parentId) request.parent_id = target.parentId;
    if (target.afterId) request.after_id = target.afterId;
    if (target.date) request.project_id = 'inbox';
    else {
      request.project_id = target.projectId || 'inbox';
      request.section_id = target.sectionId || null;
    }
    return request;
  }

  /** Opens the inline composer at the end of a list (or after a task). */
  openInlineComposer(key, target) {
    if (isMobile()) {
      this.openQuickAdd({ target });
      return;
    }
    this.closeInlineComposer();
    const composer = { key, target: { ...target }, el: null };
    composer.el = createComposer({
      defaults: { dueDate: target.date || null },
      submit: async (fields) => {
        const created = await this.run(() => api.tasks.create(this.taskRequest(fields, composer.target)));
        if (!created) return false;
        if (composer.target.afterId) composer.target.afterId = created.id;
        await this.refresh();
        return true;
      },
      cancel: () => this.closeInlineComposer(),
    });
    this.composer = composer;
    this.placeComposer();
    composer.el.focusTitle();
  }

  /** Puts the open composer back in place after a render. */
  placeComposer() {
    const c = this.composer;
    if (!c) return;
    const hadFocus = c.el.contains(document.activeElement);
    const after = c.target.afterId && $('tasks').querySelector(`.task-row[data-id="${CSS.escape(c.target.afterId)}"]`);
    if (after) {
      const tree = after.parentElement.classList.contains('task-tree') ? after.parentElement : after;
      tree.after(c.el);
    } else if (this.lists.has(c.key)) {
      this.lists.get(c.key).after(c.el);
    } else {
      this.closeInlineComposer();
      return;
    }
    if (hadFocus && !c.el.contains(document.activeElement)) c.el.focusTitle();
  }

  closeInlineComposer() {
    if (!this.composer) return;
    this.composer.el.remove();
    this.composer = null;
    closePopover();
  }

  /** a: adds a task right below the cursor. */
  addBelowCursor() {
    const s = this.state;
    const task = this.cursorTask();
    if (s.view === 'upcoming') {
      const date = task ? splitDue(task.due_date).date : s.today;
      const iso = date < s.today ? s.today : date;
      this.openInlineComposer(`day:${iso}`, { date: iso });
      return;
    }
    if (!task) {
      this.openInlineComposer('root', { projectId: s.view === 'inbox' ? 'inbox' : s.projectId });
      return;
    }
    const key = task.section_id ? `section:${task.section_id}` : 'root';
    this.openInlineComposer(key, {
      projectId: task.project_id, sectionId: task.section_id, parentId: task.parent_id, afterId: task.id,
    });
  }

  /**
   * Quick add dialog. Without a target it adds to the current view (the FAB);
   * with inbox: true it always adds to the inbox (the q key).
   */
  openQuickAdd({ inbox = false, target = null } = {}) {
    const s = this.state;
    if (!target) {
      if (inbox || s.view === 'inbox') target = { projectId: 'inbox' };
      else if (s.view === 'upcoming') target = { date: s.today };
      else target = { projectId: s.projectId };
    }
    let modal;
    const composer = createComposer({
      defaults: { dueDate: target.date || null },
      submit: async (fields) => {
        const created = await this.run(() => api.tasks.create(this.taskRequest(fields, target)));
        if (!created) return false;
        modal.close();
        const where = created.project_id === 'inbox' ? 'Inbox' : created.project_name;
        if (created.project_id !== s.projectId || s.view === 'upcoming') toast(`Task added to ${where}`, { type: 'success' });
        await this.refresh();
        return true;
      },
      cancel: () => modal.close(),
    });
    modal = openModal({ className: 'quick-add', body: composer });
  }

  // -------------------------------------------------------------------------
  // Drag and drop
  // -------------------------------------------------------------------------

  canDrag(kind) {
    return !topModal() && (kind !== 'task' || !this.composerHasFocus());
  }

  composerHasFocus() {
    return !!this.composer?.el.contains(document.activeElement);
  }

  closeTransientUi() {
    closePopover();
  }

  /**
   * Interprets the position of a dragged item. Returns
   * { el, place: 'before' | 'after' | 'inside' | 'into', ...data } or null.
   */
  dropTarget(kind, id, under, x, y) {
    const s = this.state;
    if (kind === 'project') {
      const row = under.closest('.project-row[data-drop="project"]');
      if (row) {
        if (row.dataset.id === id || this.isProjectInside(row.dataset.id, id)) return null;
        const r = row.getBoundingClientRect();
        if (x - r.left > r.width * 0.6) return { el: row, place: 'inside', projectId: row.dataset.id };
        return { el: row, place: y < r.top + r.height / 2 ? 'before' : 'after', projectId: row.dataset.id };
      }
      const tree = under.closest('#project-tree');
      return tree ? { el: tree, place: 'into', projectId: null } : null;
    }

    if (kind === 'section') {
      const block = under.closest('[data-drop="section"]');
      if (block && block.dataset.sectionId !== id) {
        const r = block.getBoundingClientRect();
        return { el: block, place: y < r.top + Math.min(r.height / 2, 40) ? 'before' : 'after', sectionId: block.dataset.sectionId };
      }
      const project = under.closest('.project-row[data-drop="project"]');
      if (project && project.dataset.id !== s.projectId) return { el: project, place: 'into', projectId: project.dataset.id };
      return null;
    }

    // Tasks
    const navInbox = under.closest('[data-drop="inbox"]');
    if (navInbox) return { el: navInbox, place: 'into', projectId: 'inbox' };
    const project = under.closest('.project-row[data-drop="project"]');
    if (project) return { el: project, place: 'into', projectId: project.dataset.id };

    const row = under.closest('#tasks .task-row[data-drop="task"]');
    if (row) {
      const task = this.findTask(row.dataset.id);
      if (!task || task.id === id || this.isTaskInside(task.id, id)) return null;
      if (s.view === 'upcoming') {
        const list = row.closest('[data-drop="list"]');
        return list?.dataset.date ? { el: list, place: 'into', date: list.dataset.date } : null;
      }
      const r = row.getBoundingClientRect();
      if (x - r.left > r.width * (isMobile() ? 0.6 : 0.3)) return { el: row, place: 'inside', taskId: task.id };
      if (this.currentSort() !== 'manual') {
        const list = row.closest('.task-list[data-drop="list"]');
        return list ? this.listTarget(list) : null;
      }
      return { el: row, place: y < r.top + r.height / 2 ? 'before' : 'after', taskId: task.id };
    }
    const list = under.closest('#tasks [data-drop="list"]');
    return list ? this.listTarget(list) : null;
  }

  listTarget(list) {
    if (list.dataset.date) return { el: list, place: 'into', date: list.dataset.date };
    return { el: list, place: 'into', projectId: list.dataset.projectId, sectionId: list.dataset.sectionId || null };
  }

  async drop(kind, id, target) {
    if (kind === 'project') {
      if (target.place === 'inside') await this.run(() => api.projects.move(id, target.projectId));
      else if (target.place === 'into') await this.run(() => api.projects.move(id, null));
      else {
        const p = this.findProject(target.projectId);
        await this.run(() => api.projects.move(id, p.parent_id, { [`${target.place}_id`]: p.id }));
      }
      await this.loadProjects();
      this.render();
      return;
    }

    if (kind === 'section') {
      if (target.projectId) {
        const project = this.findProject(target.projectId);
        await this.run(() => api.sections.move(id, target.projectId));
        toast(`Section moved to ${project?.name || 'project'}`);
      } else {
        await this.run(() => api.sections.move(id, '', { [`${target.place}_id`]: target.sectionId }));
      }
      await this.refresh();
      return;
    }

    const s = this.state;
    const ids = s.selection.has(id) ? this.targetIds() : [id];
    if (target.date) return this.rescheduleTasks(ids, target.date);
    if (target.place === 'inside') return this.moveTasks(ids, { parent_id: target.taskId });
    if (target.place === 'before' || target.place === 'after') {
      const ref = this.findTask(target.taskId);
      return this.moveTasks(ids, {
        project_id: ref.project_id, section_id: ref.section_id, parent_id: ref.parent_id, [`${target.place}_id`]: ref.id,
      });
    }
    await this.moveTasks(ids, { project_id: target.projectId, section_id: target.sectionId || null });
    if (target.projectId !== s.projectId && !(target.projectId === 'inbox' && s.view === 'inbox')) {
      const name = target.projectId === 'inbox' ? 'Inbox' : this.findProject(target.projectId)?.name;
      toast(`${ids.length === 1 ? 'Task' : `${ids.length} tasks`} moved to ${name}`);
    }
  }

  isTaskInside(taskId, ancestorId) {
    const ancestor = this.findTask(ancestorId);
    return !!ancestor && !!this.findTask(taskId, ancestor.subtasks || []);
  }

  isProjectInside(projectId, ancestorId) {
    const ancestor = this.findProject(ancestorId);
    return !!ancestor && !!this.findProject(projectId, ancestor.children || []);
  }

  // -------------------------------------------------------------------------
  // Projects and sections
  // -------------------------------------------------------------------------

  createProject() {
    const name = h('input', { type: 'text', class: 'input', placeholder: 'e.g. Work, Home, Finances', maxLength: 200, autocomplete: 'off' });
    const parent = h('select', { class: 'input' },
      h('option', { value: '' }, 'None (top level)'),
      this.flatProjects().map(({ project, depth }) => h('option', { value: project.id }, `${'  '.repeat(depth)}${project.name}`)));
    if (this.state.view === 'project') parent.value = '';
    const save = async () => {
      if (!name.value.trim()) {
        name.focus();
        return;
      }
      const created = await this.run(() => api.projects.create(name.value.trim(), parent.value || null));
      if (!created) return;
      modal.close();
      await this.loadProjects();
      await this.switchView('project', created.id);
    };
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    });
    const modal = openModal({
      title: 'New project',
      className: 'dialog',
      body: [
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Inside'), parent),
      ],
      footer: [
        h('button', { type: 'button', class: 'button', onclick: () => modal.close() }, 'Cancel'),
        h('button', { type: 'button', class: 'button primary', onclick: save }, 'Create'),
      ],
    });
  }

  async renameProject(project) {
    const name = await promptDialog('Rename project', { value: project.name, placeholder: 'Project name' });
    if (!name || name === project.name) return;
    if (await this.run(() => api.projects.rename(project.id, name))) {
      await this.loadProjects();
      this.render();
    }
  }

  async deleteProject(project) {
    const ok = await confirmDialog('Delete project', `Delete "${project.name}", its subprojects and all their tasks? This cannot be undone.`, { okText: 'Delete' });
    if (!ok || await this.run(() => api.projects.remove(project.id)) === undefined) return;
    await this.loadProjects();
    const s = this.state;
    if (s.view === 'project' && !this.findProject(s.projectId)) await this.switchView('inbox');
    else await this.refresh();
  }

  async moveSidebarProject(direction) {
    const row = sidebarRows()[this.state.sidebarIndex];
    if (row?.dataset.nav !== 'project') return;
    const project = this.findProject(row.dataset.id);
    const siblings = this.projectSiblings(project.parent_id);
    const index = siblings.findIndex((p) => p.id === project.id);
    let move = null;
    if (direction === 'up' && index > 0) move = [project.parent_id, { before_id: siblings[index - 1].id }];
    if (direction === 'down' && index < siblings.length - 1) move = [project.parent_id, { after_id: siblings[index + 1].id }];
    if (direction === 'indent' && index > 0) move = [siblings[index - 1].id, {}];
    if (direction === 'outdent' && project.parent_id) {
      const parent = this.findProject(project.parent_id);
      move = [parent.parent_id, { after_id: parent.id }];
    }
    if (!move || await this.run(() => api.projects.move(project.id, ...move)) === undefined) return;
    await this.loadProjects();
    this.render();
    this.state.sidebarIndex = sidebarRows().findIndex((r) => r.dataset.id === project.id);
    this.renderSidebarCursor();
  }

  async setSort(sort) {
    const s = this.state;
    const projectId = s.view === 'inbox' ? 'inbox' : s.projectId;
    if (await this.run(() => api.projects.setSort(projectId, sort)) === undefined) return;
    if (s.view === 'inbox') s.inboxSort = sort;
    else {
      const p = this.findProject(projectId);
      if (p) p.sort_by = sort;
    }
    await this.refresh();
  }

  async addSection() {
    const name = await promptDialog('New section', { placeholder: 'e.g. In progress, Ideas', okText: 'Add' });
    if (!name) return;
    if (await this.run(() => api.sections.create(this.state.projectId, name))) await this.refresh();
  }

  async renameSection(section) {
    const name = await promptDialog('Rename section', { value: section.name, placeholder: 'Section name' });
    if (!name || name === section.name) return;
    if (await this.run(() => api.sections.rename(section.id, name))) await this.refresh();
  }

  async deleteSection(section) {
    const ok = await confirmDialog('Delete section', `Delete "${section.name}" and all its tasks? This cannot be undone.`, { okText: 'Delete' });
    if (ok && await this.run(() => api.sections.remove(section.id)) !== undefined) await this.refresh();
  }

  pickSectionDestination(section) {
    openPicker({
      placeholder: `Move "${section.name}" to…`,
      items: (q) => this.flatProjects().map((x) => x.project)
        .filter((p) => p.id !== this.state.projectId && p.name.toLowerCase().includes(q.toLowerCase()))
        .map((p) => ({
          label: p.name, icon: 'hash', badge: 'Project',
          run: async () => {
            if (await this.run(() => api.sections.move(section.id, p.id)) === undefined) return;
            toast(`Section moved to ${p.name}`);
            await this.refresh();
          },
        })),
      emptyText: 'No other project',
    });
  }

  // -------------------------------------------------------------------------
  // Search, CSV, help
  // -------------------------------------------------------------------------

  openSearch() {
    openPicker({
      placeholder: 'Search tasks and projects…',
      emptyText: 'Type to search',
      items: async (q) => {
        if (!q) return [];
        const lower = q.toLowerCase();
        const projects = [{ id: 'inbox', name: 'Inbox' }, ...this.flatProjects().map((x) => x.project)]
          .filter((p) => p.name.toLowerCase().includes(lower))
          .map((p) => ({
            label: p.name, icon: p.id === 'inbox' ? 'inbox' : 'hash', badge: 'Project',
            run: () => (p.id === 'inbox' ? this.switchView('inbox') : this.switchView('project', p.id)),
          }));
        let tasks = [];
        try {
          tasks = await api.search(q);
        } catch (err) {
          this.reportError(err);
        }
        return [...projects, ...tasks.map((t) => ({
          label: t.title, icon: 'check', badge: t.project_id === 'inbox' ? 'Inbox' : t.project_name,
          run: async () => {
            await (t.project_id === 'inbox' ? this.switchView('inbox') : this.switchView('project', t.project_id));
            this.openDetail(t.id);
          },
        }))];
      },
    });
  }

  csvProjectId() {
    return this.state.view === 'project' ? this.state.projectId : 'inbox';
  }

  async exportCSV() {
    const file = await this.run(() => api.projects.exportCSV(this.csvProjectId()));
    if (!file) return;
    const url = URL.createObjectURL(file.blob);
    const link = h('a', { href: url, download: file.filename });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast(`Exported ${file.filename}`, { type: 'success' });
  }

  importCSV() {
    const input = h('input', { type: 'file', accept: '.csv,text/csv' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const result = await this.run(() => api.projects.importCSV(this.csvProjectId(), file));
      if (!result) return;
      const sections = result.sections_count ? ` and ${result.sections_count} section(s)` : '';
      toast(`Imported ${result.tasks_count} task(s)${sections}`, { type: 'success' });
      await this.refresh();
    });
    input.click();
  }

  openHelp() {
    if (topModal()?.el.classList.contains('help')) return topModal().close();
    const row = (keys, label) => h('div', { class: 'help-row' }, h('span', null, label), h('span', { class: 'help-keys' }, keys.map((k) => h('kbd', null, k))));
    openModal({
      title: 'Keyboard shortcuts',
      className: 'help',
      body: h('div', { class: 'help-grid' },
        h('section', null,
          h('h3', { class: 'field-label' }, 'Navigation'),
          row(['j', 'k'], 'Next / previous task'),
          row(['gg', 'G'], 'First / last task'),
          row(['h', 'l'], 'Sidebar / tasks'),
          row(['Enter'], 'Open task (or project in the sidebar)'),
          row(['/'], 'Search'),
          row(['?'], 'This help'),
          row(['Esc'], 'Close, leave a field, clear selection'),
          h('h3', { class: 'field-label' }, 'Sidebar'),
          row(['J', 'K'], 'Move project down / up'),
          row(['L', 'H'], 'Nest / un-nest project')),
        h('section', null,
          h('h3', { class: 'field-label' }, 'Tasks'),
          row(['a'], 'Add a task below'),
          row(['q'], 'Quick add to the inbox'),
          row(['d'], 'Complete'),
          row(['u'], 'Undo completion'),
          row(['1', '2', '3'], 'Priority (also & é " on AZERTY)'),
          row(['Space'], 'Select / unselect'),
          row(['m'], 'Move to project'),
          row(['s'], 'Move to section (Upcoming: to a day)'),
          row(['J', 'K'], 'Move down / up (manual order)'),
          row(['L', 'H'], 'Make subtask / un-nest'),
          h('h3', { class: 'field-label' }, 'Task details'),
          row(['Enter'], 'Edit the title'),
          row(['a'], 'Add a subtask'),
          row(['Ctrl', 'Enter'], 'Save the description'))),
    });
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  passwordForm({ title, intro, fields, submitLabel, dismissible, onSubmit }) {
    const error = h('div', { class: 'form-error', hidden: true });
    const inputs = fields.map((f) => h('input', {
      type: 'password', class: 'input', placeholder: f.placeholder, autocomplete: f.autocomplete, attrs: { 'aria-label': f.label },
    }));
    const submit = h('button', { type: 'submit', class: 'button primary wide' }, submitLabel);
    const form = h('form', { class: 'auth-form' },
      intro ? h('p', { class: 'dialog-message' }, intro) : null,
      error,
      fields.map((f, i) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, f.label), inputs[i])),
      submit);
    let modal;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      try {
        const message = await onSubmit(inputs.map((i) => i.value));
        if (message) {
          error.textContent = message;
          error.hidden = false;
        } else {
          modal.close();
        }
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    });
    modal = openModal({ title, body: form, className: 'dialog auth', dismissible });
    return modal;
  }

  showSetup() {
    closeAllModals({ keepUndismissible: false });
    this.state.auth.authenticated = false;
    this.passwordForm({
      title: 'Welcome to Get Done',
      intro: 'Choose a master password to protect this instance. You can change it later.',
      fields: [
        { label: 'Master password', placeholder: 'At least 4 characters', autocomplete: 'new-password' },
        { label: 'Confirm password', placeholder: 'Repeat the password', autocomplete: 'new-password' },
      ],
      submitLabel: 'Set password and continue',
      dismissible: false,
      onSubmit: async ([password, confirm]) => {
        if (password.length < 4) return 'The password must be at least 4 characters long.';
        if (password !== confirm) return 'The passwords do not match.';
        await api.auth.setup(password);
        this.afterLogin();
        return null;
      },
    });
  }

  showLogin() {
    if (topModal()?.el.classList.contains('auth')) return;
    closeAllModals({ keepUndismissible: false });
    this.detail.modal = null;
    this.state.auth.authenticated = false;
    this.passwordForm({
      title: 'Get Done is locked',
      intro: 'Enter your master password to unlock.',
      fields: [{ label: 'Password', placeholder: 'Master password', autocomplete: 'current-password' }],
      submitLabel: 'Unlock',
      dismissible: false,
      onSubmit: async ([password]) => {
        if (!password) return 'Enter your password.';
        await api.auth.login(password);
        this.afterLogin();
        return null;
      },
    });
  }

  async afterLogin() {
    this.state.auth = { ...this.state.auth, has_password: true, authenticated: true };
    await this.loadProjects();
    await this.switchView(this.state.view, this.state.projectId);
  }

  changePassword() {
    this.passwordForm({
      title: 'Change password',
      fields: [
        { label: 'Current password', placeholder: 'Current master password', autocomplete: 'current-password' },
        { label: 'New password', placeholder: 'At least 4 characters', autocomplete: 'new-password' },
        { label: 'Confirm new password', placeholder: 'Repeat the new password', autocomplete: 'new-password' },
      ],
      submitLabel: 'Update password',
      dismissible: true,
      onSubmit: async ([current, next, confirm]) => {
        if (next.length < 4) return 'The new password must be at least 4 characters long.';
        if (next !== confirm) return 'The new passwords do not match.';
        await api.auth.changePassword(current, next);
        toast('Password updated. Other devices were signed out.', { type: 'success' });
        return null;
      },
    });
  }

  async lock() {
    await this.run(() => api.auth.logout());
    this.showLogin();
  }

  showFatal(err) {
    const retry = h('button', { type: 'button', class: 'button primary', onclick: () => { modal.close(); this.boot(); } }, 'Retry');
    const modal = openModal({
      title: 'Get Done is unavailable',
      className: 'dialog',
      dismissible: false,
      body: h('p', { class: 'dialog-message' }, err.message),
      footer: retry,
    });
  }

  // -------------------------------------------------------------------------
  // Static chrome (header, sidebar, status bar)
  // -------------------------------------------------------------------------

  openSidebar() {
    $('sidebar').classList.add('open');
    $('sidebar-backdrop').classList.add('open');
  }

  closeSidebar() {
    $('sidebar').classList.remove('open');
    $('sidebar-backdrop').classList.remove('open');
  }

  bindChrome() {
    const setIcon = (id, name) => $(id).prepend(icon(name));
    setIcon('brand', 'brandLogo');
    setIcon('auth-menu', 'lock');
    setIcon('add-project', 'plus');
    setIcon('menu-toggle', 'menu');
    setIcon('sort-button', 'sort');
    setIcon('add-section', 'plus');
    setIcon('delete-project', 'trash');
    setIcon('more-button', 'more');
    setIcon('fab', 'plus');

    $('menu-toggle').addEventListener('click', () => this.openSidebar());
    $('sidebar-backdrop').addEventListener('click', () => this.closeSidebar());
    $('add-project').addEventListener('click', () => this.createProject());
    $('auth-menu').addEventListener('click', () => openMenu($('auth-menu'), [
      { label: 'Change password', icon: 'key', run: () => this.changePassword() },
      { label: 'Lock', icon: 'lock', run: () => this.lock() },
    ], { title: 'Security' }));
    $('sort-button').addEventListener('click', () => openMenu($('sort-button'), Object.entries(SORT_LABELS).map(([sort, label]) => ({
      label, selected: this.currentSort() === sort, run: () => this.setSort(sort),
    })), { title: 'Sort by' }));
    $('add-section').addEventListener('click', () => this.addSection());
    $('delete-project').addEventListener('click', () => {
      const p = this.findProject(this.state.projectId);
      if (p) this.deleteProject(p);
    });
    $('more-button').addEventListener('click', () => {
      const items = [{ label: 'Undo completion', icon: 'undo', hint: 'u', run: () => this.undo() }];
      if (this.state.view !== 'upcoming') {
        items.push('separator',
          { label: 'Export (Todoist CSV)', icon: 'download', run: () => this.exportCSV() },
          { label: 'Import (Todoist CSV)', icon: 'upload', run: () => this.importCSV() });
      }
      openMenu($('more-button'), items);
    });
    $('fab').addEventListener('click', () => this.openQuickAdd());
    $('view-title').addEventListener('click', () => {
      if (isMobile() && this.state.view !== 'inbox') this.switchView('inbox');
    });
    $('status-help').addEventListener('click', () => this.openHelp());
  }
}

const app = new App();
window.addEventListener('DOMContentLoaded', () => app.start());
