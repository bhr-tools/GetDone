// Task detail panel: edit every field of a task, browse and add subtasks.
// A centered dialog on desktop, a bottom sheet on phones.

import { h, icon, autoGrow, isTextInput, isMobile, mapsUrl } from '../dom.js';
import { api } from '../api.js';
import { formatDue, recurrenceLabel, splitDue, WEEKDAYS } from '../dates.js';
import { parseQuickAdd } from '../quickadd.js';
import { openModal, openPopover, closePopover, menuList, confirmDialog, toast } from '/kit/js/overlay.js';
import { datePicker } from '../ui/datepicker.js';
import { taskRow } from './tasks.js';
import { PRIORITY_LABELS, createComposer } from './composer.js';
import { attachmentsBlock, pickFiles, uploadFiles } from './attachments.js';

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
      if (!await this.dropSubtaskComposer()) return;
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
    if (!await this.dropSubtaskComposer()) return;
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
    // A cross on a desktop; on a phone, "‹ Back" at the left of the page.
    const closeButton = h('button', { type: 'button', class: 'icon-button detail-close', title: 'Close (Esc)', attrs: { 'aria-label': 'Close' }, onclick: () => this.close() },
      icon('close'), h('span', { class: 'detail-close-back' }, icon('chevronLeft'), 'Back'));

    this.check = h('button', { type: 'button', class: 'task-check large', title: 'Complete', onclick: () => this.complete() }, icon('check'));
    this.title = h('textarea', { class: 'detail-title', rows: 1, maxLength: 500, placeholder: 'Task name', attrs: { 'aria-label': 'Task name' } });
    this.chips = h('div', { class: 'token-chips', hidden: true });
    this.description = h('textarea', { class: 'detail-description', placeholder: 'Description', attrs: { 'aria-label': 'Description' } });
    this.files = h('div');

    this.subtaskList = h('div', { class: 'task-list compact' });
    this.subtaskCount = h('span', { class: 'group-count' });
    // Subtasks are added with the task composer, like tasks in a list.
    this.subtaskAdd = h('button', { type: 'button', class: 'add-task', onclick: () => this.openSubtaskComposer() },
      icon('plus'), h('span', null, 'Add subtask'));
    this.subtaskComposer = null;
    this.fields = h('div', { class: 'detail-fields' });

    this.title.addEventListener('input', () => {
      autoGrow(this.title);
      this.renderChips();
    });
    this.title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.leaveField();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelText(this.title, this.task.title);
      }
    });
    // Opening the discard question blurs the field: that is not a save.
    this.title.addEventListener('blur', () => { if (this.confirming !== this.title) this.commitTitle(); });
    this.description.addEventListener('input', () => autoGrow(this.description, 64));
    this.description.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.leaveField();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelText(this.description, this.task.description);
      }
    });
    this.description.addEventListener('blur', () => { if (this.confirming !== this.description) this.commitDescription(); });

    const body = h('div', { class: 'detail' },
      h('header', { class: 'detail-header' }, this.back, this.place, h('div', { class: 'spacer' }), closeButton),
      h('div', { class: 'detail-body' },
        h('div', { class: 'detail-main' },
          h('div', { class: 'detail-title-row' }, this.check, this.title),
          this.chips,
          this.description,
          this.files,
          h('section', { class: 'detail-subtasks' },
            h('header', { class: 'group-header' }, h('h3', { class: 'group-title' }, 'Subtasks'), this.subtaskCount),
            this.subtaskList,
            this.subtaskAdd)),
        this.fields));

    this.modal = openModal({
      className: 'detail-modal',
      autofocus: false,
      body,
      onEscape: () => this.close(),
      onClose: () => {
        this.modal = null;
        this.subtaskComposer = null;
        this.task = null;
        this.history = [];
      },
    });
    this.modal.el.addEventListener('keydown', (e) => this.onKey(e));
    this.enableFileDrop(this.modal.el);
  }

  /** Shows this.task. Text fields being edited are left alone unless resetText. */
  fill({ resetText = false } = {}) {
    const t = this.task;
    const editing = (field) => document.activeElement === field || this.confirming === field;
    if (resetText || !editing(this.title)) {
      this.title.value = t.title;
      this.chips.hidden = true;
    }
    if (resetText || !editing(this.description)) this.description.value = t.description || '';
    requestAnimationFrame(() => {
      autoGrow(this.title);
      autoGrow(this.description, 64);
    });
    this.check.className = `task-check large p${t.priority}`;
    this.renderBack();
    this.renderFiles();
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

  renderFiles() {
    this.files.replaceChildren(attachmentsBlock(this.task, {
      onAttach: () => this.attach(),
      onRemove: (a) => this.removeFile(a),
    }));
  }

  attach() {
    const id = this.task.id;
    pickFiles((files) => this.upload(id, files));
  }

  async upload(taskId, files) {
    if (await uploadFiles(taskId, files, (err) => this.app.reportError(err)) && this.task?.id === taskId) this.reload();
  }

  async removeFile(a) {
    try {
      await api.attachments.remove(a.id);
    } catch (err) {
      this.app.reportError(err);
      return;
    }
    if (this.task?.id === a.task_id) this.reload();
    toast(`Removed ${a.filename}`, {
      action: {
        label: 'Undo',
        run: () => api.attachments.restore(a.id).then(() => this.task?.id === a.task_id && this.reload(), (err) => this.app.reportError(err)),
      },
    });
  }

  /** Files dropped on the details, or an image pasted outside a text field, are attached. */
  enableFileDrop(el) {
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    el.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      el.classList.add('file-over');
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('file-over');
    });
    el.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      el.classList.remove('file-over');
      const files = [...e.dataTransfer.files];
      if (files.length && this.task) this.upload(this.task.id, files);
    });
    el.addEventListener('paste', (e) => {
      if (isTextInput(e.target) || !this.task) return;
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      this.upload(this.task.id, files);
    });
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
      this.dueField = fieldButton('Due date', 'calendar', due ? due.text : 'No date', (b) => openPopover(b,
        datePicker(t.due_date, (value) => { closePopover(); this.update({ due_date: value }); }), { title: 'Due date' }),
      due ? `due ${due.status}` : ''),
      fieldButton('Repeat', 'repeat', t.recurrence ? recurrenceLabel(t.recurrence) : 'Does not repeat', (b) => this.pickRepeat(b)),
      fieldButton('Priority', 'flag', PRIORITY_LABELS[t.priority], (b) => openPopover(b, menuList([1, 2, 3].map((p) => ({
        label: PRIORITY_LABELS[p], icon: 'flag', className: `p${p}`, selected: t.priority === p, run: () => this.update({ priority: p }),
      }))), { title: 'Priority' }), `p${t.priority}`));

    const location = this.locationInput = h('input', { type: 'text', class: 'input', value: t.location || '', placeholder: 'Place or address', maxLength: 500, attrs: { 'aria-label': 'Location' } });
    const saveLocation = () => {
      const v = location.value.trim() || null;
      if (v !== (this.task.location || null)) this.update({ location: v });
    };
    location.addEventListener('blur', saveLocation);
    location.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.leaveField();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        location.value = this.task.location || '';
        this.leaveField();
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

  /** Ends text editing and hands the keys back to the dialog (Enter edits again). */
  leaveField() {
    this.modal?.el.focus({ preventScroll: true });
  }

  /**
   * Escape in a text field: drops the edits, after asking when there are any.
   * Nothing is saved meanwhile, so "Keep editing" goes back to the same edits
   * with the saved value still as the reference (Escape asks again).
   */
  async cancelText(field, saved) {
    if (this.confirming) return;
    if (field.value.trim() !== (saved || '').trim()) {
      this.confirming = field;
      let discard;
      try {
        discard = await confirmDialog('Discard changes?', 'Your edits to this field will be lost.', { okText: 'Discard', cancelText: 'Keep editing' });
      } finally {
        this.confirming = null;
      }
      if (!this.task) return;
      if (!discard) {
        field.focus();
        return;
      }
      // The field still holds the edits; whatever the task holds now is the reference.
      saved = field === this.title ? this.task.title : this.task.description;
    }
    field.value = saved || '';
    this.chips.hidden = true;
    this.leaveField();
  }

  /** The parent and place the new subtask goes to. */
  subtaskTarget() {
    const t = this.task;
    return { projectId: t.project_id, sectionId: t.section_id, parentId: t.id };
  }

  /**
   * a / Add subtask: the task composer, inline under the subtasks on a
   * desktop, full screen on a phone, as for tasks in a list.
   */
  openSubtaskComposer() {
    if (isMobile()) {
      this.app.openQuickAdd({ target: this.subtaskTarget(), onAdded: () => this.reload(), submitLabel: 'Add subtask' });
      return;
    }
    if (this.subtaskComposer) {
      this.subtaskComposer.focusTitle();
      return;
    }
    const composer = createComposer({
      submitLabel: 'Add subtask',
      submit: async (fields) => {
        const created = await this.app.run(() => api.tasks.create(this.app.taskRequest(fields, this.subtaskTarget())));
        if (!created) return false;
        await this.reload();
        this.app.refresh();
        return true;
      },
      cancel: () => this.closeSubtaskComposer(),
    });
    this.subtaskComposer = composer;
    this.subtaskAdd.hidden = true;
    this.subtaskList.after(composer);
    composer.focusTitle();
  }

  /** Drops the subtask being written, once confirmed: false when kept. */
  async dropSubtaskComposer() {
    return !this.subtaskComposer || this.subtaskComposer.requestCancel();
  }

  closeSubtaskComposer() {
    this.subtaskComposer?.remove();
    this.subtaskComposer = null;
    this.subtaskAdd.hidden = false;
    closePopover();
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
    if (!await this.dropSubtaskComposer()) return;
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
      this.openSubtaskComposer();
    } else if (e.key === 'f') {
      e.preventDefault();
      this.attach();
    } else if (e.key === 't') {
      e.preventDefault();
      this.dueField?.querySelector('button').click();
    } else if (e.key === 'w') {
      e.preventDefault();
      this.locationInput?.focus();
      this.locationInput?.select();
    }
  }
}
