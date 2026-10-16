// Vim Keyboard Navigation Engine

export class VimEngine {
  constructor(app) {
    this.app = app;
    this.mode = 'NORMAL'; // 'NORMAL' | 'INSERT'
    this.pendingKey = null;
    this.pendingTimeout = null;

    this.bindEvents();
    this.updateStatus();
  }

  setMode(mode) {
    this.mode = mode;
    this.updateStatus();
  }

  updateStatus() {
    const modeEl = document.getElementById('vim-mode');
    if (modeEl) {
      if (this.mode === 'INSERT') {
        modeEl.textContent = '-- INSERT --';
        modeEl.className = 'vim-mode insert';
      } else if (this.app.focusArea === 'sidebar') {
        modeEl.textContent = '-- SIDEBAR --';
        modeEl.className = 'vim-mode';
      } else {
        modeEl.textContent = '-- NORMAL --';
        modeEl.className = 'vim-mode';
      }
    }
  }

  bindEvents() {
    // Detect focus in inputs/textareas to switch to INSERT mode
    document.addEventListener('focusin', (e) => {
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) {
        this.setMode('INSERT');
      }
    });

    document.addEventListener('focusout', (e) => {
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) {
        setTimeout(() => {
          const active = document.activeElement;
          if (!active || !['INPUT', 'TEXTAREA'].includes(active.tagName)) {
            if (this.app?.isModalOpen() && document.querySelector('#modal-quick-add.open')) {
              return;
            }
            this.setMode('NORMAL');
          }
        }, 30);
      }
    });

    window.addEventListener('keydown', (e) => this.handleKeyDown(e));
  }

  handleKeyDown(e) {
    const confirmModal = document.getElementById('modal-confirm');
    if (confirmModal && confirmModal.classList.contains('open')) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.app.handleConfirmCancel?.();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        this.app.handleConfirmOk?.();
        return;
      }
      return;
    }

    // INSERT mode
    if (this.mode === 'INSERT') {
      if (e.key === 'Escape') {
        e.preventDefault();
        const detailModal = document.getElementById('modal-task-detail');
        if (detailModal && detailModal.classList.contains('open')) {
          this.app.handleDetailModalEscape();
          return;
        }
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
        this.app.closeAllModals();
        this.setMode('NORMAL');
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        const active = document.activeElement;
        if (active && active.id === 'detail-desc') {
          e.preventDefault();
          this.app.saveActiveDetailTask?.();
          this.app.isDescEditing = false;
          active.blur();
          this.setMode('NORMAL');
          return;
        }
      }
      return;
    }

    // Modal open handling: block ALL vim commands when any modal or task panel is in the foreground
    if (this.app.isModalOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        const detailModal = document.getElementById('modal-task-detail');
        if (detailModal && detailModal.classList.contains('open')) {
          this.app.handleDetailModalEscape();
          return;
        }
        this.app.closeAllModals();
        return;
      }
      const detailModal = document.getElementById('modal-task-detail');
      if (detailModal && detailModal.classList.contains('open')) {
        if (e.key === 'Enter') {
          const activeTag = document.activeElement ? document.activeElement.tagName.toUpperCase() : '';
          if (activeTag !== 'INPUT' && activeTag !== 'TEXTAREA') {
            e.preventDefault();
            this.app.enterDetailEditMode?.();
            return;
          }
        }
        if (e.key === 'a' || e.key === 'A') {
          const activeTag = document.activeElement ? document.activeElement.tagName.toUpperCase() : '';
          if (activeTag !== 'INPUT' && activeTag !== 'TEXTAREA' && activeTag !== 'SELECT') {
            e.preventDefault();
            this.app.focusDetailSubtaskInput?.();
            return;
          }
        }
      }
      return;
    }

    if (e.ctrlKey || e.altKey || e.metaKey) {
      return;
    }

    // Multi-key sequences (gg)
    if (this.pendingKey) {
      const seq = this.pendingKey + e.key;
      clearTimeout(this.pendingTimeout);
      this.pendingKey = null;

      if (seq === 'gg') {
        e.preventDefault();
        this.app.selectFirstTask();
        return;
      }
    }

    // --- SIDEBAR FOCUS NAVIGATION ---
    if (this.app.focusArea === 'sidebar') {
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          this.app.selectNextSidebarItem();
          return;

        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          this.app.selectPrevSidebarItem();
          return;

        case 'J': // Shift + J : move project down
          e.preventDefault();
          this.app.moveSelectedSidebarProjectDown();
          return;

        case 'K': // Shift + K : move project up
          e.preventDefault();
          this.app.moveSelectedSidebarProjectUp();
          return;

        case 'L': // Shift + L : indent project under previous sibling
          e.preventDefault();
          this.app.indentSelectedSidebarProject();
          return;

        case 'H': // Shift + H : outdent project to parent's level
          e.preventDefault();
          this.app.outdentSelectedSidebarProject();
          return;

        case 'Enter':
        case 'l':
        case 'ArrowRight':
          e.preventDefault();
          this.app.activateSelectedSidebarItem();
          return;

        case 'h':
        case 'ArrowLeft':
          e.preventDefault();
          return;

        case 'Escape':
          e.preventDefault();
          this.app.focusTasks();
          return;

        case '/':
          e.preventDefault();
          this.app.openGlobalSearch();
          return;

        case '?':
          e.preventDefault();
          this.app.toggleHelpModal();
          return;
      }
    }

    // --- TASKS FOCUS NAVIGATION (NORMAL MODE) ---
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        this.app.selectNextTask();
        break;

      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        this.app.selectPrevTask();
        break;

      case 'J': // Shift + J : move task down
        e.preventDefault();
        this.app.moveSelectedTaskDown();
        break;

      case 'K': // Shift + K : move task up
        e.preventDefault();
        this.app.moveSelectedTaskUp();
        break;

      case 'L': // Shift + L : indent task under task above
        e.preventDefault();
        this.app.indentSelectedTask();
        break;

      case 'H': // Shift + H : outdent task
        e.preventDefault();
        this.app.outdentSelectedTask();
        break;

      case '1':
      case '&': // AZERTY 1
        e.preventDefault();
        this.app.setSelectedTaskPriority(1);
        break;

      case '2':
      case 'é': // AZERTY 2
        e.preventDefault();
        this.app.setSelectedTaskPriority(2);
        break;

      case '3':
      case '"': // AZERTY 3
        e.preventDefault();
        this.app.setSelectedTaskPriority(3);
        break;

      case 'h':
      case 'ArrowLeft':
        e.preventDefault();
        this.app.focusSidebar();
        break;

      case 'l':
      case 'ArrowRight':
        e.preventDefault();
        this.app.focusTasks();
        break;

      case 'a':
        e.preventDefault();
        this.app.openQuickAddBelow();
        break;

      case 's': // s: Move task to section in current project
        e.preventDefault();
        this.app.openMoveTaskToSectionModal();
        break;

      case ' ': // Space: Yazi-style task selection toggle
        e.preventDefault();
        this.app.toggleSelectTask();
        break;

      case 'm': // m: Move selected tasks (or active task) to project
        e.preventDefault();
        this.app.openMoveTaskModal();
        break;

      case 'd': // d: Complete / delete task
        e.preventDefault();
        this.app.completeSelectedTask();
        break;

      case 'u': // u: Vim undo (restore deleted task)
        e.preventDefault();
        this.app.undoLastAction();
        break;

      case 'g':
        e.preventDefault();
        this.pendingKey = 'g';
        this.pendingTimeout = setTimeout(() => { this.pendingKey = null; }, 1000);
        break;

      case 'G':
        e.preventDefault();
        this.app.selectLastTask();
        break;

      case 'e':
      case 'Enter':
        e.preventDefault();
        this.app.editSelectedTask();
        break;

      case '/':
        e.preventDefault();
        this.app.openGlobalSearch();
        break;

      case 'q':
        e.preventDefault();
        this.app.openQuickAddInbox();
        break;

      case '?':
        e.preventDefault();
        this.app.toggleHelpModal();
        break;

      case 'Escape':
        if (this.app.selectedTaskIds && this.app.selectedTaskIds.size > 0) {
          this.app.clearSelection();
        } else {
          this.app.closeAllModals();
          this.app.focusTasks();
        }
        break;
    }
  }
}
