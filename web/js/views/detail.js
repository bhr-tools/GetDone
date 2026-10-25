// Task detail panel: edit every field of a task, browse and add subtasks.
// A centered dialog on desktop, a bottom sheet on phones.

import { h, icon, autoGrow, isTextInput, mapsUrl } from '../dom.js';
import { api } from '../api.js';
import { formatDue, recurrenceLabel, splitDue, WEEKDAYS } from '../dates.js';
import { parseQuickAdd } from '../quickadd.js';
import { openModal, openPopover, closePopover, menuList, confirmDialog } from '../ui/overlay.js';
import { datePicker } from '../ui/datepicker.js';
import { taskRow } from './tasks.js';
import { PRIORITY_LABELS } from './composer.js';

const REPEAT_CHOICES = [
  [null, 'Does not repeat'],
  ['daily', 'Every day'],
  ['weekdays', 'Every weekday (Mon–Fri)'],
  ['weekly', 'Every week'],
  ['monthly', 'Every month'],
  ['yearly', 'Every year'],
];

export class TaskDetail {
  constructor(app) {
    this.app = app;
    this.modal = null;
    this.task = null;
    this.history = []; // ids of the tasks we came from
  }

  get isOpen() {
    return this.modal !== null;
  }

  /** Opens a task. With `fromCurrent`, Back returns to the task shown now. */
  async open(id, { fromCurrent = false } = {}) {
    let task;
    try {
      task = await api.tasks.get(id);
    } catch (err) {
      this.app.reportError(err);
      return;
    }
    if (this.isOpen) {
      await this.commitText();
      if (fromCurrent && this.task) this.history.push(this.task.id);
    } else {
      this.history = [];
      this.build();
    }
    this.task = task;
    this.ignored = new Set();
    this.fill({ resetText: true });
  }

  /** Saves the text being edited, then closes. */
  async close() {
    if (!this.modal) return;
    await this.commitText();
    this.modal?.close();
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  build() {
    this.back = h('button', { type: 'button', class: 'detail-back', onclick: () => this.goBack() },
      h('span', { class: 'detail-back-arrow' }, '‹'), h('span', { class: 'detail-back-label' }));
    this.place = h('span', { class: 'detail-place' });
    const closeButton = h('button', { type: 'button', class: 'icon-button', title: 'Close (Esc)', onclick: () => this.close() }, icon('close'));
    const handle = h('div', { class: 'sheet-handle' });

    this.check = h('button', { type: 'button', class: 'task-check large', title: 'Complete', onclick: () => this.complete() }, icon('check'));
    this.title = h('textarea', { class: 'detail-title', rows: 1, maxLength: 500, placeholder: 'Task name', attrs: { 'aria-label': 'Task name' } });
    this.chips = h('div', { class: 'token-chips', hidden: true });
    this.description = h('textarea', { class: 'detail-description', placeholder: 'Description', attrs: { 'aria-label': 'Description' } });

    this.subtaskList = h('div', { class: 'task-list compact' });
    this.subtaskCount = h('span', { class: 'group-count' });
    this.subtaskInput = h('input', { type: 'text', class: 'input', placeholder: 'Add a subtask', maxLength: 500, autocomplete: 'off' });
    this.fields = h('div', { class: 'detail-fields' });

    this.title.addEventListener('input', () => {
      autoGrow(this.title);
      this.renderChips();
    });
    this.title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.title.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelText(this.title, this.task.title);
      }
    });
    this.title.addEventListener('blur', () => this.commitTitle());
    this.description.addEventListener('input', () => autoGrow(this.description, 64));
    this.description.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.description.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelText(this.description, this.task.description);
      }
    });
    this.description.addEventListener('blur', () => this.commitDescription());
    this.subtaskInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.addSubtask();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.subtaskInput.value = '';
        this.subtaskInput.blur();
      }
    });

    const body = h('div', { class: 'detail' },
      h('header', { class: 'detail-header' }, handle, this.back, this.place, h('div', { class: 'spacer' }), closeButton),
      h('div', { class: 'detail-body' },
        h('div', { class: 'detail-main' },
          h('div', { class: 'detail-title-row' }, this.check, this.title),
          this.chips,
          this.description,
          h('section', { class: 'detail-subtasks' },
            h('header', { class: 'group-header' }, h('h3', { class: 'group-title' }, 'Subtasks'), this.subtaskCount),
            this.subtaskList,
            this.subtaskInput)),
        this.fields));

    this.modal = openModal({
      className: 'detail-modal',
      autofocus: false,
      body,
      onEscape: () => this.close(),
      onClose: () => {
        this.modal = null;
        this.task = null;
        this.history = [];
      },
    });
    this.modal.el.addEventListener('keydown', (e) => this.onKey(e));
    enableSheetGestures(this.modal.el, handle, () => this.close());
  }

  /** Shows this.task. Text fields being edited are left alone unless resetText. */
  fill({ resetText = false } = {}) {
    const t = this.task;
    if (resetText || document.activeElement !== this.title) {
      this.title.value = t.title;
      this.chips.hidden = true;
    }
    if (resetText || document.activeElement !== this.description) this.description.value = t.description || '';
    requestAnimationFrame(() => {
      autoGrow(this.title);
      autoGrow(this.description, 64);
    });
    this.check.className = `task-check large p${t.priority}`;
    this.renderBack();
    this.renderSubtasks();
    this.renderFields();
  }

  renderBack() {
    const t = this.task;
    const label = this.back.querySelector('.detail-back-label');
    this.back.hidden = !this.history.length && !t.parent_id;
    this.place.hidden = !this.back.hidden;
    label.textContent = '';
    if (this.back.hidden) {
      this.renderPlace();
      return;
    }
    const backId = this.history[this.history.length - 1] || t.parent_id;
    label.textContent = 'Back';
    api.tasks.get(backId).then((back) => {
      if (this.task === t) label.textContent = back.title;
    }).catch(() => {});
  }

  /** "# Project › Section" breadcrumb shown for top-level tasks. */
  async renderPlace() {
    const t = this.task;
    const inbox = t.project_id === 'inbox';
    const parts = [inbox ? 'Inbox' : (this.app.findProject(t.project_id)?.name || t.project_name)];
    this.place.replaceChildren(icon(inbox ? 'inbox' : 'hash'), parts[0]);
    if (!t.section_id) return;
    const section = (await this.app.sectionsOf(t.project_id)).find((s) => s.id === t.section_id);
    if (section && this.task === t) this.place.append(` › ${section.name}`);
  }

  renderSubtasks() {
    const subs = this.task.subtasks || [];
    this.subtaskCount.textContent = subs.length || '';
    const ctx = {
      app: {
        state: this.app.state,
        openDetail: (id) => this.open(id, { fromCurrent: true }),
        completeTasks: async (ids) => {
          await this.app.completeTasks(ids);
          this.reload();
        },
      },
    };
    this.subtaskList.replaceChildren(...subs.map((st) => taskRow(ctx, st, { compact: true })));
  }

  renderFields() {
    const t = this.task;
    const app = this.app;
    const project = t.project_id === 'inbox' ? { name: 'Inbox' } : app.findProject(t.project_id);
    const fieldButton = (label, iconName, text, onClick, className = '') => {
      const button = h('button', { type: 'button', class: ['field-button', className] }, icon(iconName), h('span', { class: 'field-value' }, text), h('span', { class: 'field-caret' }, '▾'));
      button.addEventListener('click', () => onClick(button));
      return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), button);
    };

    const fields = [
      fieldButton('Project', t.project_id === 'inbox' ? 'inbox' : 'hash', project?.name || t.project_name || 'Project', (b) => this.pickProject(b)),
    ];
    if (t.project_id !== 'inbox') {
      fields.push(fieldButton('Section', 'folder', '…', (b) => this.pickSection(b), 'section-button'));
      this.fillSectionName(fields[fields.length - 1]);
    }
    const due = t.due_date ? formatDue(t.due_date, app.state.today) : null;
    fields.push(
      fieldButton('Due date', 'calendar', due ? due.text : 'No date', (b) => openPopover(b,
        datePicker(t.due_date, (value) => { closePopover(); this.update({ due_date: value }); }), { title: 'Due date' }),
      due ? `due ${due.status}` : ''),
      fieldButton('Repeat', 'repeat', t.recurrence ? recurrenceLabel(t.recurrence) : 'Does not repeat', (b) => this.pickRepeat(b)),
      fieldButton('Priority', 'flag', PRIORITY_LABELS[t.priority], (b) => openPopover(b, menuList([1, 2, 3].map((p) => ({
        label: PRIORITY_LABELS[p], icon: 'flag', className: `p${p}`, selected: t.priority === p, run: () => this.update({ priority: p }),
      }))), { title: 'Priority' }), `p${t.priority}`));

    const location = h('input', { type: 'text', class: 'input', value: t.location || '', placeholder: 'Place or address', maxLength: 500, attrs: { 'aria-label': 'Location' } });
    const saveLocation = () => {
      const v = location.value.trim() || null;
      if (v !== (this.task.location || null)) this.update({ location: v });
    };
    location.addEventListener('blur', saveLocation);
    location.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        location.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        location.value = this.task.location || '';
        location.blur();
      }
    });
    fields.push(h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'Location'),
      location,
      t.location ? h('a', { class: 'maps-link', href: mapsUrl(t.location), target: '_blank', rel: 'noopener noreferrer' }, icon('pin'), 'Open in Maps') : null));

    this.fields.replaceChildren(...fields);
  }

  async fillSectionName(field) {
    const t = this.task;
    const value = field.querySelector('.field-value');
    if (!t.section_id) {
      value.textContent = 'No section';
      return;
    }
    const sections = await this.app.sectionsOf(t.project_id);
    if (this.task === t) value.textContent = sections.find((s) => s.id === t.section_id)?.name || 'No section';
  }

  // -------------------------------------------------------------------------
  // Pickers
  // -------------------------------------------------------------------------

  pickProject(button) {
    const t = this.task;
    const items = [{ label: 'Inbox', icon: 'inbox', selected: t.project_id === 'inbox', run: () => this.moveTo('inbox', null) }];
    const walk = (projects, depth) => {
      for (const p of projects) {
        items.push({
          label: `${'   '.repeat(depth)}${p.name}`, icon: 'hash', selected: t.project_id === p.id,
          run: () => this.moveTo(p.id, null),
        });
        walk(p.children || [], depth + 1);
      }
    };
    walk(this.app.state.projects, 0);
    openPopover(button, menuList(items), { title: 'Move to project', className: 'scrollable' });
  }

  async pickSection(button) {
    const t = this.task;
    const sections = await this.app.sectionsOf(t.project_id);
    openPopover(button, menuList([
      { label: 'No section', selected: !t.section_id, run: () => this.moveTo(t.project_id, null) },
      ...sections.map((s) => ({ label: s.name, icon: 'folder', selected: t.section_id === s.id, run: () => this.moveTo(t.project_id, s.id) })),
    ]), { title: 'Move to section', className: 'scrollable' });
  }

  pickRepeat(button) {
    const t = this.task;
    const items = REPEAT_CHOICES.map(([rule, label]) => ({
      label, selected: (t.recurrence || null) === rule, run: () => this.update({ recurrence: rule }),
    }));
    const { date } = splitDue(t.due_date);
    if (date) {
      const weekday = WEEKDAYS[new Date(`${date}T00:00:00`).getDay()].toLowerCase();
      items.splice(4, 0, {
        label: recurrenceLabel(`weekly:${weekday}`), selected: t.recurrence === `weekly:${weekday}`,
        run: () => this.update({ recurrence: `weekly:${weekday}` }),
      });
    }
    const cron = h('input', {
      type: 'text', class: 'input', placeholder: 'Cron, e.g. 0 9 * * 1', autocomplete: 'off',
      value: t.recurrence?.startsWith('cron:') ? t.recurrence.slice(5) : '',
      attrs: { 'aria-label': 'Custom cron rule' },
    });
    cron.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && cron.value.trim()) {
        e.preventDefault();
        closePopover();
        this.update({ recurrence: `cron:${cron.value.trim()}` });
      }
    });
    openPopover(button, h('div', null, menuList(items),
      h('div', { class: 'popover-form' }, h('label', { class: 'field-label' }, 'Custom (minute hour day month weekday)'), cron)), { title: 'Repeat' });
  }

  // -------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------

  async update(fields) {
    const id = this.task.id;
    try {
      const task = await api.tasks.update(id, fields);
      if (this.task?.id === id) {
        this.task = task;
        this.fill();
      }
      this.app.refresh();
    } catch (err) {
      this.app.reportError(err);
      this.fill();
    }
  }

  async moveTo(projectId, sectionId) {
    const t = this.task;
    if (t.project_id === projectId && (t.section_id || null) === sectionId && !t.parent_id) return;
    try {
      this.task = await api.tasks.move(t.id, { project_id: projectId, section_id: sectionId });
      this.history = [];
      this.fill();
      this.app.refresh();
    } catch (err) {
      this.app.reportError(err);
    }
  }

  renderChips() {
    const parsed = parseQuickAdd(this.title.value, { today: this.app.state.today, ignored: this.ignored });
    this.chips.replaceChildren(...parsed.tokens.map((token) => h('button', {
      type: 'button', class: ['token-chip', token.type, token.type === 'priority' && `p${parsed.priority}`],
      title: 'Click to keep this text in the title',
      onmousedown: (e) => e.preventDefault(),
      onclick: () => { this.ignored.add(token.type); this.renderChips(); },
    }, token.label, ' ×')));
    this.chips.hidden = parsed.tokens.length === 0;
  }

  /** Saves the title; tokens typed in it (dates, priority…) fill the fields. */
  async commitTitle() {
    if (!this.task) return;
    const raw = this.title.value.trim();
    this.chips.hidden = true;
    if (!raw || raw === this.task.title) {
      this.title.value = this.task.title;
      return;
    }
    const parsed = parseQuickAdd(raw, { today: this.app.state.today, ignored: this.ignored });
    const fields = { title: parsed.title || raw };
    if (parsed.priority) fields.priority = parsed.priority;
    if (parsed.dueDate) fields.due_date = parsed.dueDate;
    if (parsed.recurrence) fields.recurrence = parsed.recurrence;
    if (parsed.location) fields.location = parsed.location;
    this.ignored = new Set();
    this.title.value = fields.title;
    await this.update(fields);
  }

  async commitDescription() {
    if (!this.task) return;
    const value = this.description.value.trim();
    if (value !== (this.task.description || '')) await this.update({ description: value });
  }

  /** Saves any text being edited (before closing or switching task). */
  async commitText() {
    if (document.activeElement === this.title) await this.commitTitle();
    else if (document.activeElement === this.description) await this.commitDescription();
  }

  async cancelText(field, saved) {
    if (field.value.trim() !== (saved || '').trim()) {
      const discard = await confirmDialog('Discard changes?', 'Your edits to this field will be lost.', { okText: 'Discard', cancelText: 'Keep editing' });
      if (!discard) {
        field.focus();
        return;
      }
    }
    field.value = saved || '';
    this.chips.hidden = true;
    field.blur();
  }

  async addSubtask() {
    const text = this.subtaskInput.value.trim();
    if (!text) return;
    const parsed = parseQuickAdd(text, { today: this.app.state.today });
    try {
      await api.tasks.create({
        title: parsed.title || text,
        parent_id: this.task.id,
        priority: parsed.priority || 3,
        due_date: parsed.dueDate,
        recurrence: parsed.recurrence,
        location: parsed.location,
      });
      this.subtaskInput.value = '';
      await this.reload();
      this.app.refresh();
    } catch (err) {
      this.app.reportError(err);
    }
  }

  async reload() {
    if (!this.task) return;
    try {
      this.task = await api.tasks.get(this.task.id);
      this.fill();
    } catch (err) {
      if (err.status === 404) this.close();
      else this.app.reportError(err);
    }
  }

  async complete() {
    const t = this.task;
    await this.app.completeTasks([t.id]);
    if (t.recurrence) return this.reload();
    if (this.history.length || t.parent_id) return this.goBack({ skipCommit: true });
    this.close();
  }

  async goBack({ skipCommit = false } = {}) {
    if (!skipCommit) await this.commitText();
    const backId = this.history.pop() || this.task?.parent_id;
    if (!backId) return this.close();
    try {
      this.task = await api.tasks.get(backId);
      this.fill({ resetText: true });
    } catch {
      this.close();
    }
  }

  onKey(e) {
    if (e.defaultPrevented || isTextInput(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      this.title.focus();
      this.title.setSelectionRange(this.title.value.length, this.title.value.length);
    } else if (e.key === 'a') {
      e.preventDefault();
      this.subtaskInput.focus();
    }
  }
}

/** Phone bottom sheet: drag the handle down to close, up to expand. */
function enableSheetGestures(sheet, handle, close) {
  let startY = 0;
  let dy = 0;
  let dragging = false;
  const header = handle.parentElement;
  header.addEventListener('touchstart', (e) => {
    if (e.target.closest('button')) return;
    dragging = true;
    startY = e.touches[0].clientY;
    dy = 0;
    sheet.style.transition = 'none';
  }, { passive: true });
  header.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    dy = e.touches[0].clientY - startY;
    if (dy > 0 || !sheet.classList.contains('expanded')) sheet.style.transform = `translateY(${Math.max(dy, -40)}px)`;
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > 90) {
      if (sheet.classList.contains('expanded')) sheet.classList.remove('expanded');
      else close();
    } else if (dy < -40) {
      sheet.classList.add('expanded');
    }
  };
  header.addEventListener('touchend', end);
  header.addEventListener('touchcancel', end);
  handle.addEventListener('click', () => sheet.classList.toggle('expanded'));
}
