import { Icons } from './icons.js';
import { VimEngine } from './vim.js';
import { parseQuickTokens, renderPreviewBadges } from './quickadd.js';
import { initTouchDrag } from './touch.js';

function attachSingleTap(element, handler) {
  if (!element) return;
  let lastTouchTime = 0;
  let isMoving = false;
  element.addEventListener('touchstart', () => {
    isMoving = false;
  }, { passive: true });
  element.addEventListener('touchmove', () => {
    isMoving = true;
  }, { passive: true });
  element.addEventListener('touchend', (e) => {
    if (isMoving) return;
    e.preventDefault();
    lastTouchTime = Date.now();
    handler(e);
  }, { passive: false });
  element.addEventListener('click', (e) => {
    if (Date.now() - lastTouchTime < 400) {
      e.preventDefault();
      return;
    }
    handler(e);
  });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatAbsDate(date, now) {
  const day = date.getDate();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[date.getMonth()];
  if (date.getFullYear() === now.getFullYear()) {
    return `${day} ${month}`;
  }
  return `${day} ${month} ${date.getFullYear()}`;
}

export function formatTaskDueDate(dueDateStr) {
  if (!dueDateStr) return { text: '', status: null };

  const parts = dueDateStr.split(' ');
  const datePart = parts[0];
  const timePart = parts[1] ? ` ${parts[1]}` : '';

  const [y, m, d] = datePart.split('-').map(Number);
  if (!y || !m || !d) return { text: dueDateStr, status: null };

  const now = new Date();
  const todayZero = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const taskDateZero = new Date(y, m - 1, d);

  const diffMs = taskDateZero.getTime() - todayZero.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  let label = '';
  let status = 'future';

  if (diffDays < 0) {
    status = 'overdue';
    if (diffDays === -1) {
      label = 'Yesterday';
    } else {
      label = formatAbsDate(taskDateZero, now);
    }
  } else if (diffDays === 0) {
    status = 'today';
    label = 'Today';
  } else if (diffDays === 1) {
    status = 'future';
    label = 'Tomorrow';
  } else if (diffDays >= 2 && diffDays <= 6) {
    status = 'future';
    const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    label = weekdayNames[taskDateZero.getDay()];
  } else {
    status = 'future';
    label = formatAbsDate(taskDateZero, now);
  }

  return {
    text: `${label}${timePart}`,
    status,
    diffDays,
    iso: datePart,
  };
}

export function renderRosePineCalendar(container, selectedIso, onSelect) {
  if (!container) return;
  container.innerHTML = '';

  let viewDate = selectedIso ? new Date(selectedIso.slice(0, 10) + 'T00:00:00') : new Date();
  if (isNaN(viewDate.getTime())) viewDate = new Date();
  let currentYear = viewDate.getFullYear();
  let currentMonth = viewDate.getMonth();

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const weekdayInitials = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  const calEl = document.createElement('div');
  calEl.className = 'rp-calendar';

  const renderMonth = () => {
    calEl.innerHTML = `
      <div class="rp-calendar-header">
        <span class="rp-calendar-title">${monthNames[currentMonth]} ${currentYear}</span>
        <div class="rp-calendar-nav-group">
          <button type="button" class="rp-calendar-nav-btn btn-prev-month" title="Previous month">&lt;</button>
          <button type="button" class="rp-calendar-nav-btn btn-today-month" title="Reset to today">o</button>
          <button type="button" class="rp-calendar-nav-btn btn-next-month" title="Next month">&gt;</button>
        </div>
      </div>
      <div class="rp-calendar-weekdays">
        ${weekdayInitials.map((w) => `<span>${w}</span>`).join('')}
      </div>
      <div class="rp-calendar-grid"></div>
    `;

    calEl.querySelector('.btn-prev-month').addEventListener('click', (e) => {
      e.stopPropagation();
      currentMonth--;
      if (currentMonth < 0) {
        currentMonth = 11;
        currentYear--;
      }
      renderMonth();
    });

    calEl.querySelector('.btn-today-month').addEventListener('click', (e) => {
      e.stopPropagation();
      const today = new Date();
      currentMonth = today.getMonth();
      currentYear = today.getFullYear();
      renderMonth();
    });

    calEl.querySelector('.btn-next-month').addEventListener('click', (e) => {
      e.stopPropagation();
      currentMonth++;
      if (currentMonth > 11) {
        currentMonth = 0;
        currentYear++;
      }
      renderMonth();
    });

    const grid = calEl.querySelector('.rp-calendar-grid');

    const rawFirstDay = new Date(currentYear, currentMonth, 1).getDay();
    const firstDay = (rawFirstDay + 6) % 7;
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(currentYear, currentMonth, 0).getDate();

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

    // Prev month days
    for (let i = firstDay - 1; i >= 0; i--) {
      const d = daysInPrevMonth - i;
      const cell = document.createElement('div');
      cell.className = 'rp-calendar-day other-month';
      cell.textContent = d;
      const prevM = currentMonth === 0 ? 12 : currentMonth;
      const prevY = currentMonth === 0 ? currentYear - 1 : currentYear;
      const iso = `${prevY}-${pad2(prevM)}-${pad2(d)}`;
      if (iso === todayStr) cell.classList.add('today');
      if (selectedIso && selectedIso.slice(0, 10) === iso) cell.classList.add('selected');
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelect(iso);
      });
      grid.appendChild(cell);
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      const cell = document.createElement('div');
      const iso = `${currentYear}-${pad2(currentMonth + 1)}-${pad2(d)}`;
      cell.className = 'rp-calendar-day';
      if (iso === todayStr) cell.classList.add('today');
      if (selectedIso && selectedIso.slice(0, 10) === iso) cell.classList.add('selected');
      cell.textContent = d;
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelect(iso);
      });
      grid.appendChild(cell);
    }

    // Next month days to fill 35 or 42 grid slots
    const totalCells = firstDay + daysInMonth;
    const remaining = totalCells > 35 ? 42 - totalCells : 35 - totalCells;
    for (let d = 1; d <= remaining; d++) {
      const cell = document.createElement('div');
      cell.className = 'rp-calendar-day other-month';
      cell.textContent = d;
      const nextM = currentMonth === 11 ? 1 : currentMonth + 2;
      const nextY = currentMonth === 11 ? currentYear + 1 : currentYear;
      const iso = `${nextY}-${pad2(nextM)}-${pad2(d)}`;
      if (iso === todayStr) cell.classList.add('today');
      if (selectedIso && selectedIso.slice(0, 10) === iso) cell.classList.add('selected');
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelect(iso);
      });
      grid.appendChild(cell);
    }
  };

  renderMonth();
  container.appendChild(calEl);
}

class GetDoneApp {
  constructor() {
    this.projects = [];
    this.sections = [];
    this.tasks = [];
    this.flattenedTasks = [];
    this.selectedIndex = -1;
    this.currentView = 'inbox'; // 'inbox' | 'upcoming' | 'project'
    this.currentProjectId = null;
    this.currentSort = 'manual';
    this.activeTaskDetail = null;
    this.taskDetailHistory = [];
    this.focusArea = 'tasks'; // 'tasks' | 'sidebar'
    this.sidebarIndex = 0;
    this.undoStack = [];

    this.draggedTaskId = null;
    this.draggedProjectId = null;
    this.draggedSectionId = null;
    this.confirmCallback = null;
    this.selectedTaskIds = new Set();
    this.projectDueStatuses = {};
    this.detailModalInitialState = null;
    this.isTitleEditing = false;
    this.isDescEditing = false;
    this.activeSubtaskInput = false;
    this.detailIgnoredTokens = new Set();
    this.preservedScrollTop = undefined;

    this.isAuthenticated = true;
    this.hasPassword = true;

    // Intercept 401 Unauthorized responses globally
    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await origFetch(...args);
      if (res.status === 401 && typeof args[0] === 'string' && !args[0].includes('/api/auth/')) {
        if (this.isAuthenticated) {
          this.isAuthenticated = false;
          this.openAuthLoginModal();
        }
      }
      return res;
    };

    try {
      this.initIcons();
    } catch (e) {
      console.error('Failed to init icons:', e);
    }
    try {
      this.initDOM();
    } catch (e) {
      console.error('Failed to init DOM:', e);
    }
    try {
      this.vim = new VimEngine(this);
    } catch (e) {
      console.error('Failed to init Vim:', e);
    }
    try {
      initTouchDrag(this);
    } catch (e) {
      console.error('Failed to init TouchDrag:', e);
    }

    this.initApp();
  }

  async initApp() {
    try {
      const isAuthed = await this.checkAuthStatus();
      if (isAuthed) {
        await this.loadProjects();
        await this.switchView('inbox');
      }
    } catch (err) {
      console.error('Failed during app init, falling back to loading tasks:', err);
      try {
        await this.loadTasks();
      } catch (loadErr) {
        console.error('Fallback loadTasks failed:', loadErr);
      }
    }
  }

  // ----------------------------------------------------------------------
  // Initialization & Icons
  // ----------------------------------------------------------------------

  initIcons() {
    const setIcon = (id, icon) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = icon;
    };

    setIcon('icon-nav-upcoming', Icons.calendar);
    setIcon('icon-nav-inbox', Icons.inbox);
    setIcon('btn-add-project', Icons.plus);
    setIcon('icon-fab-plus', Icons.plus);
    setIcon('btn-menu-toggle', Icons.menu);
    setIcon('icon-auth-lock', Icons.lock);
    setIcon('setup-lock-icon', Icons.lock);
    setIcon('login-lock-icon', Icons.lock);
    setIcon('change-pwd-lock-icon', Icons.key);
    setIcon('modal-change-pwd-close', Icons.close);
    setIcon('icon-sort', Icons.sort);
    setIcon('btn-delete-project', Icons.trash);
    setIcon('detail-btn-close', Icons.close);
    setIcon('icon-view-more', Icons.more);
    setIcon('icon-export-csv', Icons.download);
    setIcon('icon-import-csv', Icons.upload);
    setIcon('icon-undo-action', Icons.undo);
    setIcon('mobile-project-icon', Icons.inbox);
    setIcon('mobile-date-icon', Icons.calendar);
    setIcon('mobile-chip-desc-icon', `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="21" y1="6" x2="3" y2="6"></line><line x1="17" y1="12" x2="3" y2="12"></line><line x1="21" y1="18" x2="3" y2="18"></line></svg>`);
    setIcon('mobile-chip-priority-icon', Icons.flag);
    setIcon('mobile-chip-location-icon', Icons.pin);
    setIcon('modal-project-close', Icons.close);
    setIcon('modal-help-close', Icons.close);
    setIcon('modal-move-sec-close', Icons.close);
    setIcon('modal-add-section-close', Icons.close);
    setIcon('modal-quick-add-close', Icons.close);
    setIcon('modal-prompt-close', Icons.close);
    setIcon('search-icon', Icons.sort);
    setIcon('move-task-icon', Icons.hash);
    setIcon('move-task-sec-icon', Icons.folder);
    setIcon('brand-logo', Icons.brandLogo);

    setIcon('pop-icon-today', Icons.today);
    setIcon('pop-icon-tomorrow', Icons.tomorrow);
    setIcon('pop-icon-weekend', Icons.weekend);
    setIcon('pop-icon-nextweek', Icons.nextWeek);
    setIcon('pop-icon-nodate', Icons.noDate);

    setIcon('mobile-pop-icon-today', Icons.today);
    setIcon('mobile-pop-icon-tomorrow', Icons.tomorrow);
    setIcon('mobile-pop-icon-nextweek', Icons.nextWeek);
    setIcon('mobile-pop-icon-nodate', Icons.noDate);

    setIcon('sheet-pri-icon-1', Icons.flag);
    setIcon('sheet-pri-icon-2', Icons.flag);
    setIcon('sheet-pri-icon-3', Icons.flag);

    setIcon('detail-due-date-icon', Icons.calendar);
  }

  initDOM() {
    // Navigation
    document.querySelectorAll('.nav-item').forEach((el) => {
      let touchMoved = false;
      let startX = 0;
      let startY = 0;
      el.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        touchMoved = false;
      }, { passive: true });

      el.addEventListener('touchmove', (e) => {
        const dx = Math.abs(e.touches[0].clientX - startX);
        const dy = Math.abs(e.touches[0].clientY - startY);
        if (dx > 8 || dy > 8) touchMoved = true;
      }, { passive: true });

      el.addEventListener('touchend', (e) => {
        if (touchMoved) return;
        e.preventDefault();
        this.switchView(el.dataset.view);
      });

      el.addEventListener('click', (e) => {
        e.preventDefault();
        this.switchView(el.dataset.view);
      });
    });

    document.getElementById('btn-menu-toggle')?.addEventListener('click', () => {
      const sidebar = document.querySelector('.sidebar');
      const backdrop = document.getElementById('sidebar-backdrop');
      if (sidebar) {
        const willOpen = !sidebar.classList.contains('open');
        sidebar.classList.toggle('open', willOpen);
        backdrop?.classList.toggle('active', willOpen);
      }
    });

    const backdrop = document.getElementById('sidebar-backdrop');
    backdrop?.addEventListener('click', () => this.closeSidebar());
    backdrop?.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.closeSidebar();
    });

    // Title tap on mobile -> return to Inbox
    const viewTitle = document.getElementById('view-title');
    const handleTitleClick = (e) => {
      if (window.innerWidth <= 768) {
        if (this.currentView !== 'inbox') {
          e.preventDefault();
          this.switchView('inbox');
        }
      }
    };
    viewTitle?.addEventListener('click', handleTitleClick);
    viewTitle?.addEventListener('touchend', (e) => {
      if (window.innerWidth <= 768) {
        if (this.currentView !== 'inbox') {
          e.preventDefault();
          this.switchView('inbox');
        }
      }
    });

    // Mobile FAB button to Add Task
    const mobileFab = document.getElementById('btn-mobile-fab-add');
    mobileFab?.addEventListener('click', (e) => {
      e.preventDefault();
      this.openQuickAddModal();
    });


    // Add Project Modal
    document.getElementById('btn-add-project')?.addEventListener('click', () => this.openProjectModal());
    document.getElementById('modal-project-close')?.addEventListener('click', () => this.closeAllModals());
    document.getElementById('modal-project-cancel')?.addEventListener('click', () => this.closeAllModals());
    document.getElementById('modal-project-save')?.addEventListener('click', () => this.saveProjectModal());

    const handleProjectKeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.saveProjectModal();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeAllModals();
      }
    };
    document.getElementById('modal-project-name')?.addEventListener('keydown', handleProjectKeydown);
    document.getElementById('modal-project-parent')?.addEventListener('keydown', handleProjectKeydown);

    // Add Section Modal
    document.getElementById('modal-add-section-close')?.addEventListener('click', () => this.closeAddSectionModal());
    document.getElementById('modal-add-section-cancel')?.addEventListener('click', () => this.closeAddSectionModal());
    document.getElementById('modal-add-section-save')?.addEventListener('click', () => this.submitAddSectionModal());
    document.getElementById('modal-add-section-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submitAddSectionModal();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeAddSectionModal();
      }
    });

    // Auth Menu Dropdown
    const authBtn = document.getElementById('btn-auth-menu');
    const authMenu = document.getElementById('auth-menu');
    authBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      authMenu?.classList.toggle('open');
    });
    document.addEventListener('click', () => authMenu?.classList.remove('open'));

    document.getElementById('menu-change-password')?.addEventListener('click', () => {
      authMenu?.classList.remove('open');
      this.openChangePasswordModal();
    });

    document.getElementById('menu-lock-app')?.addEventListener('click', () => {
      authMenu?.classList.remove('open');
      this.handleAuthLogout();
    });

    // Auth Forms
    document.getElementById('form-auth-setup')?.addEventListener('submit', (e) => this.handleAuthSetupSubmit(e));
    document.getElementById('form-auth-login')?.addEventListener('submit', (e) => this.handleAuthLoginSubmit(e));
    document.getElementById('form-change-password')?.addEventListener('submit', (e) => this.handleChangePasswordSubmit(e));

    document.getElementById('modal-change-pwd-close')?.addEventListener('click', () => {
      document.getElementById('modal-change-password')?.classList.remove('open');
    });
    document.getElementById('modal-change-pwd-cancel')?.addEventListener('click', () => {
      document.getElementById('modal-change-password')?.classList.remove('open');
    });
    document.getElementById('modal-change-password')?.addEventListener('click', (e) => {
      if (e.target.id === 'modal-change-password') {
        document.getElementById('modal-change-password')?.classList.remove('open');
      }
    });

    // Sort Dropdown
    const sortBtn = document.getElementById('btn-sort-dropdown');
    const sortMenu = document.getElementById('sort-menu');
    sortBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      sortMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => sortMenu?.classList.remove('open'));

    sortMenu?.querySelectorAll('.dropdown-item').forEach((item) => {
      item.addEventListener('click', async () => {
        sortMenu.querySelectorAll('.dropdown-item').forEach((i) => i.classList.remove('active'));
        item.classList.add('active');
        this.currentSort = item.dataset.sort;
        document.getElementById('sort-label').textContent = item.textContent;

        const targetProjId = this.currentView === 'project' ? this.currentProjectId : (this.currentView === 'inbox' ? 'inbox' : null);
        if (targetProjId) {
          try {
            await fetch(`/api/projects/${encodeURIComponent(targetProjId)}/sort`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sort_by: this.currentSort, sort_order: 'asc' }),
            });
            const p = this.findProjectById(targetProjId);
            if (p) {
              p.sort_by = this.currentSort;
              p.sort_order = 'asc';
            }
          } catch (e) {
            console.error('Failed to persist project sort', e);
          }
        }
        this.loadTasks();
      });
    });

    // Project Actions
    document.getElementById('btn-add-section')?.addEventListener('click', () => this.showInlineAddSection());
    document.getElementById('btn-delete-project')?.addEventListener('click', () => this.confirmDeleteCurrentProject());

    // View Options Dropdown (Todoist CSV Export / Import)
    const viewMoreBtn = document.getElementById('btn-view-more');
    const viewMoreMenu = document.getElementById('view-more-menu');
    viewMoreBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      sortMenu?.classList.remove('open');
      viewMoreMenu?.classList.toggle('open');
    });
    document.addEventListener('click', () => viewMoreMenu?.classList.remove('open'));

    document.getElementById('menu-undo-action')?.addEventListener('click', (e) => {
      e.stopPropagation();
      viewMoreMenu?.classList.remove('open');
      this.undoLastAction();
    });

    document.getElementById('menu-export-csv')?.addEventListener('click', (e) => {
      e.stopPropagation();
      viewMoreMenu?.classList.remove('open');
      this.exportProjectCSV();
    });

    const inputImportCsv = document.getElementById('input-import-csv');
    document.getElementById('menu-import-csv')?.addEventListener('click', (e) => {
      e.stopPropagation();
      viewMoreMenu?.classList.remove('open');
      if (inputImportCsv) {
        inputImportCsv.value = '';
        inputImportCsv.click();
      }
    });

    inputImportCsv?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        await this.importProjectCSV(file);
      }
    });

    // Help Modal
    document.getElementById('btn-help')?.addEventListener('click', () => this.toggleHelpModal());
    document.getElementById('modal-help-close')?.addEventListener('click', () => this.closeAllModals());

    // Task Detail
    document.getElementById('detail-btn-close')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.closeActiveTaskDetail(false);
    });
    document.getElementById('detail-btn-complete')?.addEventListener('click', () => this.completeActiveDetailTask());
    document.getElementById('detail-title-check')?.addEventListener('click', () => this.completeActiveDetailTask());
    document.getElementById('modal-task-detail')?.addEventListener('click', async (e) => {
      if (e.target.id === 'modal-task-detail') {
        await this.closeActiveTaskDetail(false);
      }
    });
    document.getElementById('modal-task-detail')?.addEventListener('touchstart', async (e) => {
      if (e.target.id === 'modal-task-detail') {
        await this.closeActiveTaskDetail(false);
      }
    }, { passive: true });

    // Task Detail Bottom Sheet swipe gestures (expand / collapse / dismiss)
    const detailOverlay = document.getElementById('modal-task-detail');
    const detailModal = document.querySelector('#modal-task-detail .detail-modal');
    const detailBody = document.querySelector('#modal-task-detail .detail-body');
    if (detailModal && detailOverlay) {
      let sheetStartY = 0;
      let sheetStartX = 0;
      let sheetCurrentY = 0;
      let isDraggingSheet = false;
      let canDragSheet = false;
      let startTime = 0;

      const onSheetTouchStart = (e) => {
        if (e.target.closest('button, input, textarea, select, .mobile-chip-btn, .popover-item, #mobile-due-date-popover, .composer-popover')) return;
        sheetStartY = e.touches[0].clientY;
        sheetStartX = e.touches[0].clientX;
        sheetCurrentY = sheetStartY;
        startTime = Date.now();
        const isHeader = !!e.target.closest('.detail-header, .detail-drag-handle');
        canDragSheet = isHeader || (!detailBody || detailBody.scrollTop <= 0);
        isDraggingSheet = false;
      };

      const onSheetTouchMove = (e) => {
        if (!canDragSheet) return;
        sheetCurrentY = e.touches[0].clientY;
        const dy = sheetCurrentY - sheetStartY;
        const dx = Math.abs(e.touches[0].clientX - sheetStartX);

        if (!isDraggingSheet && Math.abs(dy) > 8 && Math.abs(dy) > dx) {
          isDraggingSheet = true;
          detailModal.style.transition = 'none';
          detailOverlay.style.transition = 'none';
        }

        if (isDraggingSheet) {
          const isExpanded = detailModal.classList.contains('expanded');
          if (dy > 0) {
            detailModal.style.transform = `translateY(${dy}px)`;
            const bgOpacity = Math.max(0, 0.6 * (1 - dy / 450));
            detailOverlay.style.backgroundColor = `rgba(0, 0, 0, ${bgOpacity.toFixed(3)})`;
            if (e.cancelable) e.preventDefault();
          } else if (dy < 0 && !isExpanded) {
            detailModal.style.transform = `translateY(${dy}px)`;
            if (e.cancelable) e.preventDefault();
          }
        }
      };

      const onSheetTouchEnd = () => {
        if (!isDraggingSheet) {
          canDragSheet = false;
          return;
        }
        isDraggingSheet = false;
        canDragSheet = false;
        const dy = sheetCurrentY - sheetStartY;
        const elapsed = Math.max(1, Date.now() - startTime);
        const velocity = dy / elapsed; // px per ms
        const isExpanded = detailModal.classList.contains('expanded');

        const dismissSheet = () => {
          detailModal.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1)';
          detailOverlay.style.transition = 'background-color 0.22s ease';
          detailModal.style.transform = 'translateY(100%)';
          detailOverlay.style.backgroundColor = 'rgba(0, 0, 0, 0)';
          setTimeout(() => {
            detailModal.style.transform = '';
            detailModal.style.transition = '';
            detailModal.classList.remove('expanded');
            detailOverlay.style.backgroundColor = '';
            detailOverlay.style.transition = '';
            this.closeActiveTaskDetail();
          }, 210);
        };

        const snapBack = () => {
          detailModal.style.transition = 'transform 0.18s ease-out';
          detailOverlay.style.transition = 'background-color 0.18s ease-out';
          detailModal.style.transform = 'translateY(0)';
          detailOverlay.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
          setTimeout(() => {
            detailModal.style.transform = '';
            detailModal.style.transition = '';
            detailOverlay.style.backgroundColor = '';
            detailOverlay.style.transition = '';
          }, 180);
        };

        if (dy < -45 || velocity < -0.3) {
          detailModal.style.transition = 'height 0.24s cubic-bezier(0.2, 0.9, 0.3, 1), transform 0.24s cubic-bezier(0.2, 0.9, 0.3, 1)';
          detailModal.style.transform = 'translateY(0)';
          detailModal.classList.add('expanded');
          setTimeout(() => {
            detailModal.style.transform = '';
            detailModal.style.transition = '';
          }, 240);
        } else if (dy > 0) {
          if (isExpanded) {
            if (dy > 180 || velocity > 0.6) {
              dismissSheet();
            } else if (dy > 50 || velocity > 0.25) {
              detailModal.style.transition = 'height 0.22s cubic-bezier(0.2, 0.9, 0.3, 1), transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1)';
              detailModal.style.transform = 'translateY(0)';
              detailModal.classList.remove('expanded');
              setTimeout(() => {
                detailModal.style.transform = '';
                detailModal.style.transition = '';
              }, 220);
            } else {
              snapBack();
            }
          } else {
            if (dy > 50 || velocity > 0.3) {
              dismissSheet();
            } else {
              snapBack();
            }
          }
        } else {
          snapBack();
        }
      };

      detailModal.addEventListener('touchstart', onSheetTouchStart, { passive: true });
      detailModal.addEventListener('touchmove', onSheetTouchMove, { passive: false });
      detailModal.addEventListener('touchend', onSheetTouchEnd, { passive: true });
      detailModal.addEventListener('touchcancel', onSheetTouchEnd, { passive: true });
    }

    document.querySelector('.detail-drag-handle')?.addEventListener('click', () => {
      const isExpanded = detailModal?.classList.contains('expanded');
      if (isExpanded) {
        detailModal?.classList.remove('expanded');
      } else {
        detailModal?.classList.add('expanded');
      }
    });

    // Mobile Project select & row
    const mobProjSelect = document.getElementById('mobile-project-select');
    mobProjSelect?.addEventListener('change', async (e) => {
      const desktopSelect = document.getElementById('detail-project-select');
      if (desktopSelect) {
        desktopSelect.value = e.target.value;
        desktopSelect.dispatchEvent(new Event('change'));
      }
    });

    // Mobile Bottom Sheet Backdrop dismissal
    const sheetBackdrop = document.getElementById('mobile-sheet-backdrop');
    const handleBackdropDismiss = (e) => {
      e.stopPropagation();
      const cb = this.mobileBackdropDismissCallback || this.mobileBackdropCloseCallback;
      if (cb) {
        this.hideMobileBackdrop();
        cb();
      } else {
        this.closeMobileDateSheet();
        this.closeMobilePrioritySheet();
        this.closeMobileLocationSheet();
      }
    };
    sheetBackdrop?.addEventListener('click', handleBackdropDismiss);
    sheetBackdrop?.addEventListener('touchend', (e) => {
      e.preventDefault();
      handleBackdropDismiss(e);
    });

    // Mobile Date row -> open mobile due date sheet
    const mobDateRow = document.getElementById('mobile-date-row');
    const mobDatePopover = document.getElementById('mobile-due-date-popover');
    attachSingleTap(mobDateRow, (e) => {
      const isOpen = mobDatePopover && mobDatePopover.style.display === 'block';
      if (!isOpen) {
        const detailDateHidden = document.getElementById('detail-due-date');
        this.openMobileDateSheet(detailDateHidden ? detailDateHidden.value : '', async (val) => {
          const detailDateHidden = document.getElementById('detail-due-date');
          const detailDatePicker = document.getElementById('detail-due-date-picker');
          const mobDatePicker = document.getElementById('mobile-due-date-picker');
          if (detailDateHidden) detailDateHidden.value = val;
          if (detailDatePicker) detailDatePicker.value = val;
          if (mobDatePicker && mobDatePicker.value !== val) {
            mobDatePicker.value = val;
          }
          this.syncDetailDateLabel(val);
          this.updateSchedulePreview();
          await this.saveActiveDetailTask();
        });
      } else {
        this.closeMobileDateSheet();
      }
    });

    if (mobDatePopover) {
      mobDatePopover.querySelectorAll('.popover-item').forEach((item) => {
        let lastItemTime = 0;
        const handleItemSelect = async (e) => {
          const now = Date.now();
          if (now - lastItemTime < 350) return;
          lastItemTime = now;
          if (e) {
            e.stopPropagation();
            if (e.cancelable && e.type === 'pointerdown') e.preventDefault();
          }
          const action = item.dataset.action;
          const nowDate = new Date();
          let dStr = '';
          if (action === 'today') {
            dStr = nowDate.toISOString().slice(0, 10);
          } else if (action === 'tomorrow') {
            const tom = new Date(nowDate);
            tom.setDate(tom.getDate() + 1);
            dStr = tom.toISOString().slice(0, 10);
          } else if (action === 'next-week') {
            const nw = new Date(nowDate);
            nw.setDate(nw.getDate() + 7);
            dStr = nw.toISOString().slice(0, 10);
          } else if (action === 'clear') {
            dStr = '';
          }

          if (this.activeDateSheetCallback) {
            const cb = this.activeDateSheetCallback;
            this.closeMobileDateSheet();
            await cb(dStr);
            return;
          }

          const detailDateHidden = document.getElementById('detail-due-date');
          const detailDatePicker = document.getElementById('detail-due-date-picker');
          const mobDatePicker = document.getElementById('mobile-due-date-picker');
          if (detailDateHidden) detailDateHidden.value = dStr;
          if (detailDatePicker) detailDatePicker.value = dStr;
          if (mobDatePicker) {
            mobDatePicker.value = dStr;
            mobDatePicker.blur();
          }
          this.syncDetailDateLabel(dStr);
          this.closeMobileDateSheet();
          this.updateSchedulePreview();
          await this.saveActiveDetailTask();
        };

        item.addEventListener('pointerdown', handleItemSelect);
        item.addEventListener('click', handleItemSelect);
      });

      const mobDatePicker = document.getElementById('mobile-due-date-picker');
      const onMobDateChange = async (e) => {
        const val = e.target.value;
        if (this.activeDateSheetCallback) {
          const cb = this.activeDateSheetCallback;
          await cb(val);
          return;
        }
        const detailDateHidden = document.getElementById('detail-due-date');
        const detailDatePicker = document.getElementById('detail-due-date-picker');
        if (detailDateHidden) detailDateHidden.value = val;
        if (detailDatePicker) detailDatePicker.value = val;
        this.syncDetailDateLabel(val);
        this.updateSchedulePreview();
        await this.saveActiveDetailTask();
      };
      mobDatePicker?.addEventListener('change', onMobDateChange);
      mobDatePicker?.addEventListener('input', () => {
        // Picker must remain open while adjusting native wheel/calendar
      });

      const closeDateSheet = async (e) => {
        if (e) {
          e.stopPropagation();
          if (e.cancelable && e.type === 'pointerdown') e.preventDefault();
        }
        if (this.activeDateSheetCallback) {
          const picker = document.getElementById('mobile-due-date-picker');
          const val = picker ? picker.value : '';
          const cb = this.activeDateSheetCallback;
          this.closeMobileDateSheet();
          await cb(val);
          return;
        }
        const picker = document.getElementById('mobile-due-date-picker');
        if (picker) {
          const val = picker.value;
          const detailDateHidden = document.getElementById('detail-due-date');
          const detailDatePicker = document.getElementById('detail-due-date-picker');
          if (detailDateHidden) detailDateHidden.value = val;
          if (detailDatePicker) detailDatePicker.value = val;
          this.syncDetailDateLabel(val);
          picker.blur();
        }
        this.closeMobileDateSheet();
        this.updateSchedulePreview();
        await this.saveActiveDetailTask();
      };

      let lastDateDoneTime = 0;
      const onDonePress = (e) => {
        const now = Date.now();
        if (now - lastDateDoneTime < 350) return;
        lastDateDoneTime = now;
        closeDateSheet(e);
      };

      const doneBtn = document.getElementById('mobile-date-done-btn');
      const closeBtn = document.getElementById('mobile-date-close-btn');
      doneBtn?.addEventListener('pointerdown', onDonePress);
      doneBtn?.addEventListener('click', onDonePress);
      closeBtn?.addEventListener('pointerdown', onDonePress);
      closeBtn?.addEventListener('click', onDonePress);

      const mobRecSelect = document.getElementById('mobile-recurrence-select');
      const mobCronBox = document.getElementById('mobile-cron-box');
      const mobCronInput = document.getElementById('mobile-cron-input');

      mobRecSelect?.addEventListener('change', async () => {
        const val = mobRecSelect.value;
        const desktopRecSelect = document.getElementById('detail-recurrence-select');
        if (desktopRecSelect) {
          desktopRecSelect.value = val;
          desktopRecSelect.dispatchEvent(new Event('change'));
        }
        if (mobCronBox) {
          mobCronBox.style.display = val === 'custom' ? 'flex' : 'none';
        }
        this.syncRecurrenceDisplay(val);
        this.updateSchedulePreview();
        await this.saveActiveDetailTask();
      });

      mobCronInput?.addEventListener('input', () => {
        const desktopCronInput = document.getElementById('detail-cron-input');
        if (desktopCronInput) desktopCronInput.value = mobCronInput.value;
        this.updateSchedulePreview();
      });

      mobCronInput?.addEventListener('blur', async () => {
        await this.saveActiveDetailTask();
      });
    }

    // Mobile Priority & Inline Location Meta
    const mobPriorityChip = document.getElementById('mobile-chip-priority');
    attachSingleTap(mobPriorityChip, (e) => {
      const desktopSelect = document.getElementById('detail-priority-select');
      const currentP = desktopSelect ? desktopSelect.value : '3';
      this.openMobilePrioritySheet(currentP, async (p) => {
        if (desktopSelect) {
          desktopSelect.value = String(p);
          this.syncPriorityDisplay(p);
          await this.saveActiveDetailTask();
        }
      });
    });

    const mobLocInput = document.getElementById('mobile-location-input');
    const desktopLocInput = document.getElementById('detail-location-input');
    mobLocInput?.addEventListener('input', () => {
      if (desktopLocInput) desktopLocInput.value = mobLocInput.value;
      const mapsLink = document.getElementById('detail-location-maps-link');
      if (mapsLink) {
        const val = mobLocInput.value.trim();
        mapsLink.style.display = val ? 'inline-flex' : 'none';
        if (val) mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(val)}`;
      }
    });
    mobLocInput?.addEventListener('blur', async () => {
      if (desktopLocInput) desktopLocInput.value = mobLocInput.value;
      await this.saveActiveDetailTask();
    });
    mobLocInput?.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        mobLocInput.blur();
      }
    });

    desktopLocInput?.addEventListener('input', () => {
      if (mobLocInput) mobLocInput.value = desktopLocInput.value;
      const mapsLink = document.getElementById('detail-location-maps-link');
      if (mapsLink) {
        const val = desktopLocInput.value.trim();
        mapsLink.style.display = val ? 'inline-flex' : 'none';
        if (val) mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(val)}`;
      }
    });

    // Mobile Action Sheet: Priority listeners
    document.getElementById('sheet-priority-close-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeMobilePrioritySheet();
    });

    document.querySelectorAll('.sheet-priority-item').forEach((item) => {
      attachSingleTap(item, (e) => {
        const p = parseInt(item.dataset.priority, 10) || 3;
        if (this.activePrioritySheetCallback) {
          this.activePrioritySheetCallback(p);
        }
        this.closeMobilePrioritySheet();
      });
    });

    // Mobile Action Sheet: Location listeners
    document.getElementById('sheet-location-close-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeMobileLocationSheet();
    });

    const sheetLocSaveBtn = document.getElementById('sheet-location-save');
    sheetLocSaveBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const input = document.getElementById('sheet-location-input');
      const val = input ? input.value.trim() : '';
      if (this.activeLocationSheetCallback) {
        this.activeLocationSheetCallback(val);
      }
      this.closeMobileLocationSheet();
    });

    document.getElementById('sheet-location-clear')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const input = document.getElementById('sheet-location-input');
      if (input) input.value = '';
      if (this.activeLocationSheetCallback) {
        this.activeLocationSheetCallback('');
      }
      this.closeMobileLocationSheet();
    });

    document.getElementById('sheet-location-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sheetLocSaveBtn?.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeMobileLocationSheet();
      }
    });

    // PC Custom Select: Project
    const projTrigger = document.getElementById('detail-project-custom-trigger');
    const projPopover = document.getElementById('detail-project-custom-popover');
    projTrigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeAllDetailPopovers(projPopover);
      projPopover.style.display = projPopover.style.display === 'block' ? 'none' : 'block';
    });

    // PC Custom Select: Section
    const secTrigger = document.getElementById('detail-section-custom-trigger');
    const secPopover = document.getElementById('detail-section-custom-popover');
    secTrigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeAllDetailPopovers(secPopover);
      secPopover.style.display = secPopover.style.display === 'block' ? 'none' : 'block';
    });

    // PC Custom Select: Priority
    const priTrigger = document.getElementById('detail-priority-custom-trigger');
    const priPopover = document.getElementById('detail-priority-custom-popover');
    priTrigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeAllDetailPopovers(priPopover);
      priPopover.style.display = priPopover.style.display === 'block' ? 'none' : 'block';
    });

    priPopover?.querySelectorAll('.popover-item').forEach((item) => {
      item.addEventListener('click', () => {
        const val = item.dataset.value;
        const priSelect = document.getElementById('detail-priority-select');
        if (priSelect) {
          priSelect.value = val;
          priSelect.dispatchEvent(new Event('change'));
        }
        priPopover.style.display = 'none';
      });
    });

    // PC Custom Select: Recurrence
    const recTrigger = document.getElementById('detail-recurrence-custom-trigger');
    const recPopover = document.getElementById('detail-recurrence-custom-popover');
    recTrigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeAllDetailPopovers(recPopover);
      recPopover.style.display = recPopover.style.display === 'block' ? 'none' : 'block';
    });

    recPopover?.querySelectorAll('.popover-item').forEach((item) => {
      item.addEventListener('click', () => {
        const val = item.dataset.value;
        const recSelect = document.getElementById('detail-recurrence-select');
        if (recSelect) {
          recSelect.value = val;
          recSelect.dispatchEvent(new Event('change'));
        }
        recPopover.style.display = 'none';
      });
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.pc-custom-select-wrapper, #detail-due-date-popover, #mobile-due-date-popover, #mobile-date-row, #mobile-location-container')) {
        this.closeAllDetailPopovers();
      }
    });

    const detailTitleInput = document.getElementById('detail-title');
    const detailDescInput = document.getElementById('detail-desc');
    const detailTokenChips = document.getElementById('detail-token-chips');

    const updateDetailTitleSize = () => {
      if (!detailTitleInput) return;
      detailTitleInput.style.height = 'auto';
      detailTitleInput.style.height = `${detailTitleInput.scrollHeight}px`;
    };

    const handleDetailTitleOverflow = () => {
      if (!detailTitleInput) return;
      if (detailTitleInput.value.length > 500) {
        const overflow = detailTitleInput.value.slice(500);
        detailTitleInput.value = detailTitleInput.value.slice(0, 500);
        if (detailDescInput) {
          detailDescInput.value = detailDescInput.value ? (detailDescInput.value + '\n' + overflow) : overflow;
        }
      }
    };

    detailTitleInput?.addEventListener('paste', (e) => {
      const pasteText = (e.clipboardData || window.clipboardData)?.getData('text') || '';
      const currentVal = detailTitleInput.value;
      const start = detailTitleInput.selectionStart ?? currentVal.length;
      const end = detailTitleInput.selectionEnd ?? currentVal.length;
      const combined = currentVal.slice(0, start) + pasteText + currentVal.slice(end);
      if (combined.length > 500) {
        e.preventDefault();
        detailTitleInput.value = combined.slice(0, 500);
        const remainder = combined.slice(500);
        if (detailDescInput) {
          detailDescInput.value = detailDescInput.value ? (detailDescInput.value + '\n' + remainder) : remainder;
        }
        detailTitleInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    detailTokenChips?.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });

    detailTitleInput?.addEventListener('focus', () => {
      this.isTitleEditing = true;
      this.isDescEditing = false;
      this.activeSubtaskInput = false;
      this.detailIgnoredTokens = new Set();
    });

    let isValidatingDetailTitle = false;
    const validateAndSaveDetailTitle = async () => {
      if (isValidatingDetailTitle) return;
      isValidatingDetailTitle = true;
      try {
        const input = document.getElementById('detail-title');
        if (!input) return;
        const trimmed = input.value.trim();
        const initTitle = (this.initialModalTitle ?? this.initialDetailTitle ?? '').trim();

        if (trimmed !== initTitle) {
          const parsed = parseQuickTokens(input.value, new Date(), this.detailIgnoredTokens);
          if (parsed && parsed.tokens && parsed.tokens.length > 0) {
            if (parsed.dueDate && !this.detailIgnoredTokens?.has('date')) {
              const dInput = document.getElementById('detail-due-date');
              if (dInput) dInput.value = parsed.dueDate;
              const dPicker = document.getElementById('detail-due-date-picker');
              if (dPicker) dPicker.value = parsed.dueDate.slice(0, 10);
              const mobPicker = document.getElementById('mobile-due-date-picker');
              if (mobPicker) mobPicker.value = parsed.dueDate.slice(0, 10);
              this.syncDetailDateLabel(parsed.dueDate);
              this.updateSchedulePreview();
            }
            if (parsed.priority && !this.detailIgnoredTokens?.has('priority')) {
              const pSelect = document.getElementById('detail-priority-select');
              if (pSelect) pSelect.value = String(parsed.priority);
              this.syncPriorityDisplay(parsed.priority);
            }
            if (parsed.location && !this.detailIgnoredTokens?.has('location')) {
              const locInput = document.getElementById('detail-location-input');
              if (locInput) locInput.value = parsed.location;
              const mobLoc = document.getElementById('mobile-location-input');
              if (mobLoc) mobLoc.value = parsed.location;
              const mapsLink = document.getElementById('detail-location-maps-link');
              if (mapsLink) {
                mapsLink.style.display = parsed.location ? 'inline-flex' : 'none';
                if (parsed.location) mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parsed.location.trim())}`;
              }
            }
            if (parsed.project && !this.detailIgnoredTokens?.has('project')) {
              const found = this.projects?.find((p) => p.name.toLowerCase() === parsed.project.toLowerCase());
              if (found) {
                const projSelect = document.getElementById('detail-project-select');
                if (projSelect) projSelect.value = found.id;
                this.syncProjectDisplay(found.id, found.name);
              }
            }
            if (parsed.recurrence && !this.detailIgnoredTokens?.has('recurr') && !this.detailIgnoredTokens?.has('recurrence')) {
              const recSelect = document.getElementById('detail-recurrence-select');
              const cronBox = document.getElementById('detail-cron-box');
              const cronInput = document.getElementById('detail-cron-input');
              const rawRec = parsed.recurrence;
              if (rawRec.startsWith('cron:')) {
                if (recSelect) recSelect.value = 'custom';
                if (cronBox) cronBox.style.display = 'flex';
                if (cronInput) cronInput.value = rawRec.slice(5);
              } else if (['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(rawRec)) {
                if (recSelect) recSelect.value = rawRec;
                if (cronBox) cronBox.style.display = 'none';
                if (cronInput) cronInput.value = '';
              }
              if (typeof this.syncRecurrenceDisplay === 'function') {
                this.syncRecurrenceDisplay(rawRec);
              }
            }
            if (parsed.cleanTitle) {
              input.value = parsed.cleanTitle;
            }
          }
          await this.saveActiveDetailTask();
          this.initialModalTitle = input.value.trim();
          this.initialDetailTitle = this.initialModalTitle;
          if (this.detailModalInitialState) {
            this.detailModalInitialState.title = this.initialModalTitle;
          }
        }
      } catch (err) {
        console.error('Error validating detail title:', err);
      } finally {
        this.isTitleEditing = false;
        if (document.activeElement && document.activeElement.id === 'detail-title') {
          document.activeElement.blur();
        }
        const tokenChips = document.getElementById('detail-token-chips');
        if (tokenChips) {
          tokenChips.innerHTML = '';
          tokenChips.style.display = 'none';
        }
        this.vim?.setMode('NORMAL');
        isValidatingDetailTitle = false;
      }
    };

    detailTitleInput?.addEventListener('blur', async () => {
      await validateAndSaveDetailTitle();
    });

    detailDescInput?.addEventListener('focus', () => {
      this.isTitleEditing = false;
      this.isDescEditing = true;
      this.activeSubtaskInput = false;
    });
    detailDescInput?.addEventListener('blur', () => {
      this.isDescEditing = false;
    });

    const onDismissDetailToken = (token) => {
      try {
        if (!this.detailIgnoredTokens) this.detailIgnoredTokens = new Set();
        this.detailIgnoredTokens.add(token.type);
        if (token.type === 'recurr') {
          this.detailIgnoredTokens.add('recurrence');
        }
        const currentTitle = detailTitleInput ? detailTitleInput.value : '';
        const nextTokens = parseQuickTokens(currentTitle, new Date(), this.detailIgnoredTokens);
        renderPreviewBadges(nextTokens, detailTokenChips, onDismissDetailToken);
      } catch (err) {
        console.error('Error dismissing token chip:', err);
      }
    };

    const updateDetailTokens = () => {
      try {
        if (!this.detailIgnoredTokens) this.detailIgnoredTokens = new Set();
        const currentTitle = detailTitleInput ? detailTitleInput.value : '';
        const tokens = parseQuickTokens(currentTitle, new Date(), this.detailIgnoredTokens);
        renderPreviewBadges(tokens, detailTokenChips, onDismissDetailToken);
      } catch (err) {
        console.error('Error updating detail tokens:', err);
      }
    };

    detailTitleInput?.addEventListener('input', () => {
      handleDetailTitleOverflow();
      updateDetailTitleSize();
      updateDetailTokens();
    });

    detailTitleInput?.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        await validateAndSaveDetailTitle();
      }
    });

    detailDescInput?.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        await this.saveActiveDetailTask();
        this.initialDetailDesc = detailDescInput.value.trim();
        if (this.detailModalInitialState) {
          this.detailModalInitialState.description = this.initialDetailDesc;
        }
        this.isDescEditing = false;
        detailDescInput.blur();
        this.vim?.setMode('NORMAL');
      }
    });

    // Detail Modal Enter, Tab & Escape Key Actions
    const modalDetail = document.getElementById('modal-task-detail');
    modalDetail?.addEventListener('keydown', async (e) => {
      if (e.key === 'Tab') {
        if (e.target.id === 'detail-title') {
          e.preventDefault();
          e.stopPropagation();
          this.focusDetailDesc();
          return;
        }
      } else if (e.key === 'Enter') {
        const active = document.activeElement;
        const isTextInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
        if (!isTextInput) {
          e.preventDefault();
          e.stopPropagation();
          this.enterDetailEditMode();
          return;
        }
        if (e.target.id === 'detail-title') {
          e.preventDefault();
          e.stopPropagation();
          await validateAndSaveDetailTitle();
          return;
        }
        if (e.target.id === 'detail-desc') {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            e.stopPropagation();
            await this.saveActiveDetailTask();
            this.initialDetailDesc = document.getElementById('detail-desc')?.value.trim() || '';
            if (this.detailModalInitialState) {
              this.detailModalInitialState.description = this.initialDetailDesc;
            }
            this.isDescEditing = false;
            document.activeElement?.blur();
            this.vim?.setMode('NORMAL');
            return;
          }
          return;
        }
        if (e.target.id === 'detail-new-subtask-title') {
          return;
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const datePop = document.getElementById('detail-due-date-popover');
        if (datePop && datePop.style.display === 'block') {
          datePop.style.display = 'none';
          return;
        }
        this.handleDetailModalEscape();
      }
    });

    document.getElementById('detail-project-select')?.addEventListener('change', async (e) => {
      await this.updateDetailSectionOptions(e.target.value);
      this.syncProjectDisplay(e.target.value);
    });
    document.getElementById('detail-section-select')?.addEventListener('change', (e) => {
      const sec = this.sections?.find((s) => s.id === e.target.value);
      this.syncSectionDisplay(e.target.value, sec ? sec.name : '(No section)');
    });
    document.getElementById('detail-due-date')?.addEventListener('change', () => {
      this.syncDetailDateLabel(document.getElementById('detail-due-date')?.value || '');
    });

    // Detail Due Date Popover & Rosé Pine PC Calendar
    const detailDateTrigger = document.getElementById('detail-due-date-trigger');
    const detailDatePopover = document.getElementById('detail-due-date-popover');
    const detailDateHidden = document.getElementById('detail-due-date');
    const detailDatePicker = document.getElementById('detail-due-date-picker');
    const calQuickInput = document.getElementById('cal-quick-input');
    const pcCalWrap = document.getElementById('detail-pc-calendar');
    const touchPickerWrap = document.getElementById('detail-touch-picker-wrap');

    const applyDetailDueDate = async (val) => {
      if (detailDateHidden) detailDateHidden.value = val;
      if (detailDatePicker) detailDatePicker.value = val ? val.slice(0, 10) : '';
      this.syncDetailDateLabel(val);
      this.updateSchedulePreview();
      await this.saveActiveDetailTask();
      if (calQuickInput) calQuickInput.value = '';
      if (detailDatePopover) detailDatePopover.style.display = 'none';
    };

    const updateCalendarView = () => {
      if (!pcCalWrap) return;
      pcCalWrap.style.display = 'block';
      const curVal = detailDateHidden?.value || '';
      renderRosePineCalendar(pcCalWrap, curVal, async (iso) => {
        await applyDetailDueDate(iso);
      });
    };

    if (detailDateTrigger && detailDatePopover) {
      detailDateTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isMobile = window.innerWidth <= 768;
        if (isMobile) {
          const detailDateHidden = document.getElementById('detail-due-date');
          this.openMobileDateSheet(detailDateHidden ? detailDateHidden.value : '', async (val) => {
            await applyDetailDueDate(val);
          });
          return;
        }

        const isOpen = detailDatePopover.style.display === 'block';
        if (!isOpen) {
          this.updateQuickChoiceBadges();
          updateCalendarView();
          detailDatePopover.style.display = 'block';
          if (calQuickInput) {
            calQuickInput.value = '';
            requestAnimationFrame(() => calQuickInput.focus());
          }
        } else {
          detailDatePopover.style.display = 'none';
        }
      });

      calQuickInput?.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const val = calQuickInput.value.trim();
          if (!val) return;
          if (/^(no date|none|clear)$/i.test(val)) {
            await applyDetailDueDate('');
            return;
          }
          const parsed = parseQuickTokens(val, new Date());
          if (parsed && parsed.dueDate) {
            await applyDetailDueDate(parsed.dueDate);
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          detailDatePopover.style.display = 'none';
        }
      });

      detailDatePopover.querySelectorAll('.cal-choice-item').forEach((item) => {
        item.addEventListener('click', async (e) => {
          e.stopPropagation();
          const action = item.dataset.action;
          const now = new Date();
          let dStr = '';
          if (action === 'today') {
            dStr = now.toISOString().slice(0, 10);
          } else if (action === 'tomorrow') {
            const tom = new Date(now);
            tom.setDate(tom.getDate() + 1);
            dStr = tom.toISOString().slice(0, 10);
          } else if (action === 'weekend') {
            const curDay = now.getDay();
            let diffSat = 6 - curDay;
            if (diffSat <= 0) diffSat += 7;
            const sat = new Date(now);
            sat.setDate(now.getDate() + diffSat);
            dStr = sat.toISOString().slice(0, 10);
          } else if (action === 'next-week') {
            const curDay = now.getDay();
            let diffMon = (1 - curDay + 7) % 7;
            if (diffMon === 0) diffMon = 7;
            const nextMon = new Date(now);
            nextMon.setDate(now.getDate() + diffMon);
            dStr = nextMon.toISOString().slice(0, 10);
          } else if (action === 'clear') {
            dStr = '';
          }
          await applyDetailDueDate(dStr);
        });
      });

      detailDatePicker?.addEventListener('change', async (e) => {
        const val = e.target.value;
        await applyDetailDueDate(val);
      });

      document.addEventListener('click', (e) => {
        if (!detailDateTrigger.contains(e.target) && !detailDatePopover.contains(e.target) && !e.target.closest('#mobile-date-row')) {
          detailDatePopover.style.display = 'none';
        }
      });
    }

    document.getElementById('detail-priority-select')?.addEventListener('change', (e) => {
      this.syncPriorityDisplay(e.target.value);
    });
    document.getElementById('detail-recurrence-select')?.addEventListener('change', () => {
      this.syncRecurrenceDisplay(document.getElementById('detail-recurrence-select')?.value || '');
    });

    // Detail Location Input
    const locInput = document.getElementById('detail-location-input');
    locInput?.addEventListener('input', (e) => {
      const mobLoc = document.getElementById('mobile-location-input');
      if (mobLoc) mobLoc.value = e.target.value;
    });
    locInput?.addEventListener('blur', () => {
      this.saveActiveDetailTask();
    });

    // Global Search Input
    const searchInput = document.getElementById('global-search-input');
    searchInput?.addEventListener('input', (e) => this.performGlobalSearch(e.target.value));

    // Move Task Search Input
    const moveTaskInput = document.getElementById('move-task-input');
    moveTaskInput?.addEventListener('input', (e) => this.renderMoveTaskOptions(e.target.value));

    // Move Task to Section Search Input
    const moveTaskSecInput = document.getElementById('move-task-sec-input');
    moveTaskSecInput?.addEventListener('input', (e) => this.renderMoveTaskToSectionOptions(e.target.value));

    document.getElementById('modal-move-task-sec')?.addEventListener('click', (e) => {
      if (e.target.id === 'modal-move-task-sec') {
        this.closeAllModals();
      }
    });

    // Confirm Modal
    document.getElementById('confirm-btn-cancel')?.addEventListener('click', () => {
      this.handleConfirmCancel();
    });
    document.getElementById('confirm-btn-ok')?.addEventListener('click', () => {
      this.handleConfirmOk();
    });
    document.getElementById('modal-confirm')?.addEventListener('click', (e) => {
      if (e.target.id === 'modal-confirm') {
        this.handleConfirmCancel();
      }
    });

    window.addEventListener('keydown', (e) => {
      const confirmModal = document.getElementById('modal-confirm');
      if (confirmModal && confirmModal.classList.contains('open')) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.handleConfirmCancel();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          this.handleConfirmOk();
          return;
        }
      }
    }, true);

    // Prompt Modal Buttons
    document.getElementById('modal-prompt-close')?.addEventListener('click', () => {
      this.closeAllModals();
      if (this.promptCallback) this.promptCallback(null);
    });
    document.getElementById('prompt-btn-cancel')?.addEventListener('click', () => {
      this.closeAllModals();
      if (this.promptCallback) this.promptCallback(null);
    });
    document.getElementById('prompt-btn-ok')?.addEventListener('click', () => {
      const val = document.getElementById('prompt-input').value.trim();
      this.closeAllModals();
      if (this.promptCallback) this.promptCallback(val);
    });
    document.getElementById('modal-prompt')?.addEventListener('click', (e) => {
      if (e.target.id === 'modal-prompt') {
        this.closeAllModals();
        if (this.promptCallback) this.promptCallback(null);
      }
    });
    document.getElementById('prompt-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = e.target.value.trim();
        this.closeAllModals();
        if (this.promptCallback) this.promptCallback(val);
      } else if (e.key === 'Escape') {
        this.closeAllModals();
        if (this.promptCallback) this.promptCallback(null);
      }
    });

    // Global dismissal of 3-dots popover menus on click/touch outside
    const closeAnyPopoverMenus = () => {
      document.querySelectorAll('.popover-menu.open').forEach((p) => {
        p.classList.remove('open');
        p.closest('.project-row')?.classList.remove('menu-open');
        p.closest('.project-tree-item')?.classList.remove('menu-open');
      });
    };
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu-trigger-wrapper, .popover-menu')) {
        closeAnyPopoverMenus();
      }
    });
    document.addEventListener('touchstart', (e) => {
      if (!e.target.closest('.menu-trigger-wrapper, .popover-menu')) {
        closeAnyPopoverMenus();
      }
    }, { passive: true });


    // Move Section Modal
    document.getElementById('modal-move-sec-close')?.addEventListener('click', () => this.closeAllModals());
    document.getElementById('modal-move-sec-cancel')?.addEventListener('click', () => this.closeAllModals());

    // Quick Add Modal (Global 'q')
    document.getElementById('modal-quick-add')?.addEventListener('click', (e) => {
      if (e.target.id === 'modal-quick-add' || e.target.id === 'modal-quick-add-container') {
        this.closeQuickAddModal();
      }
    });

    if (window.visualViewport) {
      const handleVisualViewport = () => {
        const modal = document.getElementById('modal-quick-add');
        if (modal && modal.classList.contains('open')) {
          const offset = window.innerHeight - (window.visualViewport.height + window.visualViewport.offsetTop);
          modal.style.bottom = `${Math.max(0, offset)}px`;
        }
      };
      window.visualViewport.addEventListener('resize', handleVisualViewport);
      window.visualViewport.addEventListener('scroll', handleVisualViewport);
    }

    document.getElementById('modal-quick-add-close')?.addEventListener('click', () => this.closeQuickAddModal());
    document.getElementById('quick-add-cancel')?.addEventListener('click', () => this.closeQuickAddModal());
    document.getElementById('quick-add-submit')?.addEventListener('click', () => this.submitQuickAddModal());

    const handleQuickAddKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.submitQuickAddModal();
      } else if (e.key === 'Enter' && e.target.id === 'quick-add-title') {
        e.preventDefault();
        e.stopPropagation();
        this.submitQuickAddModal();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeQuickAddModal();
      }
    };
    document.getElementById('quick-add-title')?.addEventListener('keydown', handleQuickAddKey);
    document.getElementById('quick-add-desc')?.addEventListener('keydown', handleQuickAddKey);

    document.getElementById('status-help-trigger')?.addEventListener('click', () => this.toggleHelpModal());
  }

  // ----------------------------------------------------------------------
  // Custom Confirm & Prompt Dialogs (Zero ugly browser popups)
  // ----------------------------------------------------------------------

  confirmModal(title, message, options = {}) {
    return new Promise((resolve) => {
      const modal = document.getElementById('modal-confirm');
      document.getElementById('confirm-title').textContent = title || 'Confirm';
      document.getElementById('confirm-message').textContent = message || 'Are you sure?';
      const okBtn = document.getElementById('confirm-btn-ok');
      const cancelBtn = document.getElementById('confirm-btn-cancel');
      if (okBtn) okBtn.textContent = options.okText || 'Confirm';
      if (cancelBtn) cancelBtn.textContent = options.cancelText || 'Cancel';
      this.confirmCallback = (val) => {
        if (okBtn) okBtn.textContent = 'Confirm';
        if (cancelBtn) cancelBtn.textContent = 'Cancel';
        resolve(val);
      };
      modal.classList.add('open');
    });
  }

  handleConfirmCancel() {
    const modal = document.getElementById('modal-confirm');
    modal?.classList.remove('open');
    if (this.confirmCallback) {
      const cb = this.confirmCallback;
      this.confirmCallback = null;
      cb(false);
    }
  }

  handleConfirmOk() {
    const modal = document.getElementById('modal-confirm');
    modal?.classList.remove('open');
    if (this.confirmCallback) {
      const cb = this.confirmCallback;
      this.confirmCallback = null;
      cb(true);
    }
  }

  enterDetailEditMode() {
    const titleEl = document.getElementById('detail-title');
    if (titleEl) {
      this.isTitleEditing = true;
      this.isDescEditing = false;
      this.activeSubtaskInput = false;
      this.detailIgnoredTokens = new Set();
      titleEl.focus();
      const len = titleEl.value.length;
      titleEl.setSelectionRange(len, len);
    }
  }

  focusDetailDesc() {
    const descEl = document.getElementById('detail-desc');
    if (descEl) {
      descEl.focus();
      const len = descEl.value.length;
      descEl.setSelectionRange(len, len);
      this.isTitleEditing = false;
      this.isDescEditing = true;
    }
  }

  promptModal(title, defaultValue = '', placeholder = '') {
    return new Promise((resolve) => {
      const modal = document.getElementById('modal-prompt');
      const input = document.getElementById('prompt-input');
      document.getElementById('prompt-title').textContent = title || 'Input';
      input.value = defaultValue;
      input.placeholder = placeholder;
      this.promptCallback = resolve;
      modal.classList.add('open');
      setTimeout(() => {
        input.focus();
        input.select();
      }, 50);
    });
  }

  // ----------------------------------------------------------------------
  // Data Loading
  // ----------------------------------------------------------------------

  async loadProjects() {
    try {
      const res = await fetch('/api/projects');
      if (res.ok) {
        const data = await res.json();
        this.projects = Array.isArray(data) ? data : [];
        this.renderProjectsTree();
      }
    } catch (err) {
      console.error('Failed to load projects', err);
      this.projects = [];
    }
  }

  async loadSections(projectId) {
    if (!projectId) {
      this.sections = [];
      return;
    }
    try {
      const res = await fetch(`/api/sections?project_id=${encodeURIComponent(projectId)}`);
      if (res.ok) {
        const data = await res.json();
        this.sections = Array.isArray(data) ? data : [];
      }
    } catch (err) {
      console.error('Failed to load sections', err);
      this.sections = [];
    }
  }

  async loadTasks() {
    this.loadTasksReqId = (this.loadTasksReqId || 0) + 1;
    const reqId = this.loadTasksReqId;

    let url = `/api/tasks?view=${this.currentView}&sort=${this.currentSort}`;
    if (this.currentView === 'project' && this.currentProjectId) {
      url += `&project_id=${encodeURIComponent(this.currentProjectId)}`;
    }

    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (reqId !== this.loadTasksReqId) return;
        this.tasks = Array.isArray(data) ? data : [];
        this.renderView();
        if (this.preservedScrollTop !== undefined) {
          const scroller = document.querySelector('.main-content');
          if (scroller) scroller.scrollTop = this.preservedScrollTop;
          this.preservedScrollTop = undefined;
        }
        this.updateCounts();
      }
    } catch (err) {
      console.error('Failed to load tasks', err);
      if (reqId === this.loadTasksReqId) {
        this.tasks = [];
      }
    }
  }

  async updateCounts() {
    try {
      const resInbox = await fetch('/api/tasks?view=inbox');
      if (resInbox.ok) {
        const inboxTasks = await resInbox.json();
        const countInboxEl = document.getElementById('count-inbox');
        if (countInboxEl) countInboxEl.textContent = inboxTasks.length;
      }
      const resUpcoming = await fetch('/api/tasks?view=upcoming');
      if (resUpcoming.ok) {
        const upTasks = await resUpcoming.json();
        const countUpEl = document.getElementById('count-upcoming');
        if (countUpEl) countUpEl.textContent = upTasks.length;
        this.computeProjectDueStatuses(upTasks);
      }
    } catch (err) {
      // ignore
    }
  }

  computeProjectDueStatuses(upcomingTasks) {
    const todayIso = new Date().toISOString().slice(0, 10);
    const statuses = {};

    const checkTask = (t) => {
      if (t.project_id && t.due_date) {
        const d = t.due_date.slice(0, 10);
        if (d < todayIso) {
          statuses[t.project_id] = 'overdue';
        } else if (d === todayIso) {
          if (statuses[t.project_id] !== 'overdue') {
            statuses[t.project_id] = 'today';
          }
        }
      }
      if (t.subtasks && Array.isArray(t.subtasks)) {
        t.subtasks.forEach(checkTask);
      }
    };

    (upcomingTasks || []).forEach(checkTask);
    this.projectDueStatuses = statuses;
    this.renderProjectsTree();
  }

  getProjectDueStatus(projectId) {
    return this.projectDueStatuses ? this.projectDueStatuses[projectId] || null : null;
  }

  closeSidebar() {
    document.querySelector('.sidebar')?.classList.remove('open');
    document.getElementById('sidebar-backdrop')?.classList.remove('active');
  }

  async switchView(view, projectId = null, projectName = '', keepSidebarFocus = false) {
    this.currentView = view;
    this.currentProjectId = projectId;
    if (!keepSidebarFocus) {
      this.focusArea = 'tasks';
      this.selectedIndex = 0;
    }
    this.updateFocusVisuals();

    document.querySelectorAll('.inline-composer, .inline-section-creator').forEach((c) => c.remove());
    document.querySelectorAll('.nav-item, .project-row').forEach((el) => el.classList.remove('active'));

    const projActions = document.getElementById('project-header-actions');
    const calStrip = document.getElementById('calendar-strip');

    if (view === 'project') {
      const row = document.querySelector(`.project-row[data-id="${projectId}"]`);
      if (row) row.classList.add('active');
      document.getElementById('view-title').textContent = projectName || 'Project';
      projActions.style.display = 'flex';
      calStrip.style.display = 'none';

      const proj = this.findProjectById(projectId);
      this.currentSort = (proj && proj.sort_by) ? proj.sort_by : 'manual';

      await this.loadSections(projectId);
    } else {
      projActions.style.display = 'none';
      const item = document.querySelector(`.nav-item[data-view="${view}"]`);
      if (item) item.classList.add('active');

      if (view === 'upcoming') {
        document.getElementById('view-title').textContent = 'Upcoming';
        calStrip.style.display = 'flex';
        this.currentSort = 'manual';
      } else {
        document.getElementById('view-title').textContent = 'Inbox';
        calStrip.style.display = 'none';
        const inboxProj = this.findProjectById('inbox');
        this.currentSort = (inboxProj && inboxProj.sort_by) ? inboxProj.sort_by : 'manual';
      }
    }

    const sortMenu = document.getElementById('sort-menu');
    if (sortMenu) {
      sortMenu.querySelectorAll('.dropdown-item').forEach((i) => {
        const isMatch = i.dataset.sort === this.currentSort;
        i.classList.toggle('active', isMatch);
        if (isMatch) document.getElementById('sort-label').textContent = i.textContent;
      });
    }

    if (!keepSidebarFocus) {
      this.closeSidebar();
    }
    await this.loadTasks();

    if (keepSidebarFocus) {
      this.updateSidebarSelection();
    }
  }

  // ----------------------------------------------------------------------
  // View Rendering
  // ----------------------------------------------------------------------

  renderView() {
    const area = document.getElementById('tasks-area');
    if (!area) return;
    area.innerHTML = '';
    this.flattenedTasks = [];

    if (this.currentView === 'upcoming') {
      this.renderUpcomingView(area);
    } else if (this.currentView === 'project') {
      this.renderProjectView(area);
    } else {
      this.renderInboxView(area);
    }

    if (this.selectedIndex >= this.flattenedTasks.length) {
      this.selectedIndex = this.flattenedTasks.length - 1;
    }
    if (this.selectedIndex < 0 && this.flattenedTasks.length > 0) {
      this.selectedIndex = 0;
    }
    this.updateSelectedRow();
    this.updateTaskSelectionVisuals();
    this.updateStatusPosition();
  }

  // 1. UPCOMING VIEW (7 Days Chronological Timeline)
  renderUpcomingView(container) {
    const today = new Date();
    const todayIso = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

    // Dedicated Overdue Section at the very top (rendered only if active overdue tasks exist)
    const overdueTasks = (this.tasks || []).filter((t) => {
      const d = t.due_date ? t.due_date.slice(0, 10) : '';
      return d && d < todayIso;
    });

    if (overdueTasks.length > 0) {
      const overdueSection = document.createElement('div');
      overdueSection.className = 'section-block section-overdue';
      overdueSection.innerHTML = `
        <div class="section-header">
          <div class="section-title">
            <span style="color:var(--rp-love); font-weight:700;">Overdue</span>
            <span class="section-count" style="background-color:rgba(235, 111, 146, 0.15); color:var(--rp-love);">${overdueTasks.length}</span>
          </div>
        </div>
      `;

      const overdueList = document.createElement('div');
      overdueList.className = 'task-list';
      overdueTasks.forEach((t) => {
        try {
          this.renderTaskRow(t, overdueList);
        } catch (e) {
          console.error('Error rendering overdue task row:', t, e);
        }
      });
      overdueSection.appendChild(overdueList);
      container.appendChild(overdueSection);
    }

    const days = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      days.push({
        date: d,
        iso,
        name: dayNames[d.getDay()],
        dayNum: d.getDate(),
        month: monthNames[d.getMonth()],
        isToday: i === 0,
        isTomorrow: i === 1,
      });
    }

    // Calendar Strip
    const strip = document.getElementById('calendar-strip');
    if (strip) {
      strip.innerHTML = '';
      days.forEach((day) => {
        const card = document.createElement('div');
        card.className = `cal-day-card ${day.isToday ? 'active' : ''}`;
        card.dataset.iso = day.iso;

        const hasTasks = this.tasks.some((t) => t.due_date && t.due_date.slice(0, 10) === day.iso);
        if (hasTasks) card.classList.add('has-tasks');

        card.innerHTML = `
          <span class="cal-day-name">${day.name}</span>
          <span class="cal-day-number">${day.dayNum}</span>
          <span class="cal-day-dot"></span>
        `;
        card.addEventListener('click', () => {
          document.querySelectorAll('.cal-day-card').forEach((c) => c.classList.remove('active'));
          card.classList.add('active');
          const sectionEl = document.getElementById(`day-section-${day.iso}`);
          if (sectionEl) sectionEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        strip.appendChild(card);
      });
    }

    // Day Sections
    days.forEach((day) => {
      const section = document.createElement('div');
      section.className = 'section-block';
      section.id = `day-section-${day.iso}`;

      let label = `${day.name} ${day.dayNum} ${day.month}`;
      if (day.isToday) label = `Today · ${day.name} ${day.dayNum} ${day.month}`;
      if (day.isTomorrow) label = `Tomorrow · ${day.name} ${day.dayNum} ${day.month}`;

      const dayTasks = this.tasks.filter((t) => {
        const d = t.due_date ? t.due_date.slice(0, 10) : '';
        return d === day.iso;
      });

      section.innerHTML = `
        <div class="section-header">
          <div class="section-title">
            <span>${label}</span>
            <span class="section-count">${dayTasks.length}</span>
          </div>
        </div>
      `;

      const list = document.createElement('div');
      list.className = 'task-list';
      list.dataset.date = day.iso;
      this.attachTaskDropTarget(list, { dueDate: day.iso });
      this.attachTaskDropTarget(section, { dueDate: day.iso });

      dayTasks.forEach((t) => {
        try {
          this.renderTaskRow(t, list);
        } catch (e) {
          console.error('Error rendering day task row:', t, e);
        }
      });
      section.appendChild(list);

      const addBtn = document.createElement('div');
      addBtn.className = 'btn-add-task-trigger';
      addBtn.innerHTML = `${Icons.plus} <span>Add task</span>`;
      addBtn.addEventListener('click', () => {
        this.openInlineComposer(section, list, { dueDate: day.iso, projectId: 'inbox' });
      });
      section.appendChild(addBtn);

      container.appendChild(section);
    });
  }

  // 2. PROJECT VIEW
  renderProjectView(container) {
    // Root Tasks (without section)
    const rootTasks = (this.tasks || []).filter((t) => !t.section_id);

    const rootSection = document.createElement('div');
    rootSection.className = 'section-block';

    const rootList = document.createElement('div');
    rootList.className = 'task-list';
    this.attachTaskDropTarget(rootList, { projectId: this.currentProjectId, sectionId: null });
    this.attachTaskDropTarget(rootSection, { projectId: this.currentProjectId, sectionId: null });

    rootTasks.forEach((t) => {
      try {
        this.renderTaskRow(t, rootList);
      } catch (e) {
        console.error('Error rendering root task row:', t, e);
      }
    });
    rootSection.appendChild(rootList);

    const addBtnRoot = document.createElement('div');
    addBtnRoot.className = 'btn-add-task-trigger';
    addBtnRoot.innerHTML = `${Icons.plus} <span>Add task</span>`;
    addBtnRoot.addEventListener('click', () => {
      this.openInlineComposer(rootSection, rootList, { projectId: this.currentProjectId, sectionId: null });
    });
    rootSection.appendChild(addBtnRoot);
    container.appendChild(rootSection);

    // Named Sections
    (this.sections || []).forEach((sec) => {
      const secTasks = this.tasks.filter((t) => t.section_id === sec.id);

      const secBlock = document.createElement('div');
      secBlock.className = 'section-block';
      secBlock.dataset.sectionId = sec.id;

      const header = document.createElement('div');
      header.className = 'section-header';
      header.draggable = true;
      header.innerHTML = `
        <div class="section-title">
          <span>${sec.name}</span>
          <span class="section-count">${secTasks.length}</span>
        </div>
        <div class="menu-trigger-wrapper">
          <button class="btn-icon-subtle btn-sec-menu">${Icons.more}</button>
          <div class="popover-menu">
            <div class="popover-item item-add-task">${Icons.plus} <span>Add task</span></div>
            <div class="popover-item item-rename">${Icons.edit} <span>Rename</span></div>
            <div class="popover-item item-move">${Icons.folder} <span>Move to...</span></div>
            <div class="popover-item danger item-del">${Icons.trash} <span>Delete</span></div>
          </div>
        </div>
      `;

      // Section drag-and-drop
      header.addEventListener('dragstart', (e) => {
        if (!this.draggedTaskId) {
          this.draggedSectionId = sec.id;
          secBlock.classList.add('dragging');
          document.body.classList.add('is-dragging', 'dragging-section');
          e.dataTransfer.setData('section-id', sec.id);
          e.dataTransfer.effectAllowed = 'move';
        }
      });
      header.addEventListener('dragend', () => {
        this.draggedSectionId = null;
        secBlock.classList.remove('dragging');
        document.body.classList.remove('is-dragging', 'dragging-section');
        document.querySelectorAll('.section-block').forEach((el) => {
          el.classList.remove('drag-top', 'drag-bottom');
        });
      });

      secBlock.addEventListener('dragover', (e) => {
        if (this.draggedSectionId && this.draggedSectionId !== sec.id) {
          e.preventDefault();
          const rect = secBlock.getBoundingClientRect();
          const relY = e.clientY - rect.top;
          secBlock.classList.remove('drag-top', 'drag-bottom');

          const fromIdx = this.sections.findIndex((s) => s.id === this.draggedSectionId);
          const toIdx = this.sections.findIndex((s) => s.id === sec.id);

          if (relY < rect.height * 0.3) {
            secBlock.classList.add('drag-top');
          } else if (relY > rect.height * 0.7) {
            secBlock.classList.add('drag-bottom');
          } else {
            // Middle 40% drops between
            if (fromIdx !== -1 && toIdx !== -1 && fromIdx < toIdx) {
              secBlock.classList.add('drag-bottom');
            } else {
              secBlock.classList.add('drag-top');
            }
          }
        }
      });
      secBlock.addEventListener('dragleave', () => {
        secBlock.classList.remove('drag-top', 'drag-bottom');
      });
      secBlock.addEventListener('drop', async (e) => {
        if (this.draggedSectionId && this.draggedSectionId !== sec.id) {
          e.preventDefault();
          const rect = secBlock.getBoundingClientRect();
          const relY = e.clientY - rect.top;
          secBlock.classList.remove('drag-top', 'drag-bottom');

          const fromIdx = this.sections.findIndex((s) => s.id === this.draggedSectionId);
          const toIdx = this.sections.findIndex((s) => s.id === sec.id);
          if (fromIdx !== -1 && toIdx !== -1) {
            let isTop;
            if (relY < rect.height * 0.3) {
              isTop = true;
            } else if (relY > rect.height * 0.7) {
              isTop = false;
            } else {
              isTop = fromIdx > toIdx;
            }

            const [moved] = this.sections.splice(fromIdx, 1);
            const insertIdx = isTop ? toIdx : toIdx + 1;
            this.sections.splice(insertIdx, 0, moved);

            for (let i = 0; i < this.sections.length; i++) {
              await fetch(`/api/sections/${this.sections[i].id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: this.sections[i].name, position: i * 10 }),
              });
            }
            await this.loadSections(this.currentProjectId);
            this.loadTasks();
          }
        }
      });

      const menuBtn = header.querySelector('.btn-sec-menu');
      const popover = header.querySelector('.popover-menu');
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        popover.classList.toggle('open');
      });
      document.addEventListener('click', () => popover.classList.remove('open'));

      // Section actions
      header.querySelector('.item-rename').addEventListener('click', async () => {
        const newName = await this.promptModal('Rename Section', sec.name, 'Section name');
        if (newName && newName.trim()) {
          await fetch(`/api/sections/${sec.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName.trim(), position: sec.position }),
          });
          await this.loadSections(this.currentProjectId);
          this.loadTasks();
        }
      });

      header.querySelector('.item-add-task')?.addEventListener('click', (e) => {
        e.stopPropagation();
        header.querySelector('.popover-menu')?.classList.remove('open');
        header.classList.remove('menu-open');
        secBlock.classList.remove('menu-open');
        if (window.innerWidth <= 768) {
          this.openQuickAddModal({ projectId: this.currentProjectId, sectionId: sec.id });
        } else {
          this.openInlineComposer(secBlock, secList, { projectId: this.currentProjectId, sectionId: sec.id });
        }
      });

      header.querySelector('.item-move').addEventListener('click', () => {
        this.openMoveSectionModal(sec);
      });

      header.querySelector('.item-del').addEventListener('click', async () => {
        const confirmed = await this.confirmModal('Delete Section', `Delete "${sec.name}" and all its tasks?`);
        if (confirmed) {
          await fetch(`/api/sections/${sec.id}`, { method: 'DELETE' });
          await this.loadSections(this.currentProjectId);
          this.loadTasks();
        }
      });

      secBlock.appendChild(header);

      const secList = document.createElement('div');
      secList.className = 'task-list';
      this.attachTaskDropTarget(secList, { projectId: this.currentProjectId, sectionId: sec.id });
      this.attachTaskDropTarget(secBlock, { projectId: this.currentProjectId, sectionId: sec.id });

      secTasks.forEach((t) => {
        try {
          this.renderTaskRow(t, secList);
        } catch (e) {
          console.error('Error rendering section task row:', t, e);
        }
      });
      secBlock.appendChild(secList);

      const addBtnSec = document.createElement('div');
      addBtnSec.className = 'btn-add-task-trigger';
      addBtnSec.innerHTML = `${Icons.plus} <span>Add task</span>`;
      addBtnSec.addEventListener('click', () => {
        this.openInlineComposer(secBlock, secList, { projectId: this.currentProjectId, sectionId: sec.id });
      });
      secBlock.appendChild(addBtnSec);

      container.appendChild(secBlock);
    });

  }

  openAddSectionModal() {
    const modal = document.getElementById('modal-add-section');
    const input = document.getElementById('modal-add-section-input');
    if (!modal) return;
    if (input) input.value = '';
    modal.classList.add('open');
    document.body.classList.add('modal-open');
    setTimeout(() => input?.focus(), 80);
  }

  closeAddSectionModal() {
    const modal = document.getElementById('modal-add-section');
    modal?.classList.remove('open');
    document.body.classList.remove('modal-open');
  }

  async submitAddSectionModal() {
    const input = document.getElementById('modal-add-section-input');
    const val = input ? input.value.trim() : '';
    if (!val) {
      this.closeAddSectionModal();
      return;
    }
    this.closeAddSectionModal();
    await fetch('/api/sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: this.currentProjectId || 'inbox',
        name: val,
      }),
    });
    await this.loadSections(this.currentProjectId);
    this.loadTasks();
  }

  showInlineAddSection() {
    if (window.innerWidth <= 768) {
      this.openAddSectionModal();
      return;
    }
    document.querySelectorAll('.inline-section-creator').forEach((el) => el.remove());
    const area = document.getElementById('tasks-area');
    if (!area) return;

    const box = document.createElement('div');
    box.className = 'inline-section-creator';
    box.innerHTML = `
      <input type="text" placeholder="Section name (e.g. In Progress, Ideas...)" />
      <div class="section-creator-actions">
        <button type="button" class="btn-secondary btn-cancel">Cancel</button>
        <button type="button" class="btn-primary btn-save">Add Section</button>
      </div>
    `;

    const input = box.querySelector('input');
    let isCleanedUp = false;

    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      document.removeEventListener('click', handleOutsideClick);
      box.remove();
      this.vim.setMode('NORMAL');
    };

    const handleOutsideClick = (e) => {
      if (!box.contains(e.target) && e.target !== document.getElementById('btn-add-section')) {
        cleanup();
      }
    };

    setTimeout(() => {
      if (!isCleanedUp) {
        document.addEventListener('click', handleOutsideClick);
      }
    }, 0);

    const submit = async () => {
      const val = input.value.trim();
      if (!val) {
        cleanup();
        return;
      }
      input.disabled = true;
      input.blur();
      cleanup();
      document.body.focus();

      await fetch('/api/sections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: this.currentProjectId,
          name: val,
        }),
      });
      await this.loadSections(this.currentProjectId);
      await this.loadTasks();
      this.vim.setMode('NORMAL');
    };

    box.querySelector('.btn-save').addEventListener('click', (e) => {
      e.stopPropagation();
      submit();
    });
    box.querySelector('.btn-cancel').addEventListener('click', (e) => {
      e.stopPropagation();
      cleanup();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        submit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
      }
    });

    area.appendChild(box);
    input.focus();
    this.vim.setMode('INSERT');
  }


  // 3. INBOX VIEW
  renderInboxView(container) {
    const section = document.createElement('div');
    section.className = 'section-block';

    const list = document.createElement('div');
    list.className = 'task-list';
    this.attachTaskDropTarget(list, { projectId: 'inbox', sectionId: null });

    (this.tasks || []).forEach((t) => {
      try {
        this.renderTaskRow(t, list);
      } catch (e) {
        console.error('Error rendering inbox task row:', t, e);
      }
    });
    section.appendChild(list);

    const addBtn = document.createElement('div');
    addBtn.className = 'btn-add-task-trigger';
    addBtn.innerHTML = `${Icons.plus} <span>Add task</span>`;
    addBtn.addEventListener('click', () => {
      this.openInlineComposer(section, list, { projectId: 'inbox', sectionId: null });
    });
    section.appendChild(addBtn);

    container.appendChild(section);
  }

  // ----------------------------------------------------------------------
  // Task Row & Drag-and-Drop
  // ----------------------------------------------------------------------

  renderTaskItem(task, parentEl) {
    return this.renderTaskRow(task, parentEl);
  }

  renderTaskRow(task, parentEl) {
    const row = document.createElement('div');
    row.className = `task-row p${task.priority}`;
    if (this.selectedTaskIds && this.selectedTaskIds.has(task.id)) {
      row.classList.add('yazi-selected');
    }
    row.dataset.id = task.id;
    row.draggable = true;

    const grip = document.createElement('div');
    grip.className = 'task-grip';
    grip.innerHTML = Icons.grip;

    const check = document.createElement('div');
    check.className = 'task-check';
    check.innerHTML = Icons.check;
    check.addEventListener('click', (e) => {
      e.stopPropagation();
      this.completeTaskById(task.id);
    });
    check.addEventListener('touchend', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.completeTaskById(task.id);
    });

    const body = document.createElement('div');
    body.className = 'task-body';

    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = task.title;
    body.appendChild(title);

    if (task.description && task.description.trim()) {
      const desc = document.createElement('div');
      desc.className = 'task-desc-snippet';
      desc.textContent = task.description;
      body.appendChild(desc);
    }

    const meta = document.createElement('div');
    meta.className = 'task-meta';

    if (task.due_date) {
      const dueInfo = formatTaskDueDate(task.due_date);
      const dateBadge = document.createElement('span');
      dateBadge.className = `meta-badge date ${dueInfo.status || ''}`;
      dateBadge.innerHTML = `${Icons.calendar} <span>${dueInfo.text}</span>`;
      meta.appendChild(dateBadge);
    }

    if (task.recurrence) {
      const recBadge = document.createElement('span');
      recBadge.className = 'meta-badge recurr';
      recBadge.innerHTML = `${Icons.repeat} <span>${task.recurrence}</span>`;
      meta.appendChild(recBadge);
    }

    if (task.location) {
      const locBadge = document.createElement('a');
      locBadge.className = 'meta-badge location';
      locBadge.innerHTML = `${Icons.pin} <span>${task.location}</span>`;
      locBadge.target = '_blank';
      locBadge.rel = 'noopener noreferrer';
      const q = encodeURIComponent(task.location);
      locBadge.href = `https://www.google.com/maps/search/?api=1&query=${q}`;
      locBadge.addEventListener('click', (e) => e.stopPropagation());
      meta.appendChild(locBadge);
    }

    if (meta.children.length > 0) {
      body.appendChild(meta);
    }

    row.appendChild(grip);
    row.appendChild(check);
    row.appendChild(body);

    let taskTouchMoved = false;
    let taskStartX = 0;
    let taskStartY = 0;
    row.addEventListener('touchstart', (e) => {
      taskStartX = e.touches[0].clientX;
      taskStartY = e.touches[0].clientY;
      taskTouchMoved = false;
    }, { passive: true });

    row.addEventListener('touchmove', (e) => {
      const dx = Math.abs(e.touches[0].clientX - taskStartX);
      const dy = Math.abs(e.touches[0].clientY - taskStartY);
      if (dx > 8 || dy > 8) taskTouchMoved = true;
    }, { passive: true });

    row.addEventListener('touchend', (e) => {
      if (taskTouchMoved) return;
      if (this.draggedTaskId) return;
      if (e.target.closest('.task-check, .meta-badge.location, a, button')) return;
      e.preventDefault();
      const idx = this.flattenedTasks.findIndex((t) => t.id === task.id);
      if (idx !== -1) {
        this.selectedIndex = idx;
        this.updateSelectedRow();
        this.updateStatusPosition();
      }
      this.openTaskDetailModal(task);
    });

    row.addEventListener('click', (e) => {
      if (e.target.closest('.task-check, .task-grip, .meta-badge.location, a, button')) return;
      const idx = this.flattenedTasks.findIndex((t) => t.id === task.id);
      if (idx !== -1) {
        this.selectedIndex = idx;
        this.updateSelectedRow();
        this.updateStatusPosition();
      }
      this.openTaskDetailModal(task);
    });

    // Task Drag Events (Reorder & Move)
    row.addEventListener('dragstart', (e) => {
      this.draggedTaskId = task.id;
      row.classList.add('dragging');
      document.body.classList.add('is-dragging', 'dragging-task');
      e.dataTransfer.setData('task-id', task.id);
      e.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', () => {
      this.draggedTaskId = null;
      row.classList.remove('dragging');
      document.body.classList.remove('is-dragging', 'dragging-task');
      document.querySelectorAll('.task-row, .task-list, .project-row, .section-block').forEach((el) => {
        el.classList.remove('drag-over', 'drag-top', 'drag-bottom', 'task-drop-target');
      });
    });

    row.addEventListener('dragover', (e) => {
      if (this.draggedTaskId && this.draggedTaskId !== task.id) {
        if (this.isTaskDescendant(task.id, this.draggedTaskId)) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = row.getBoundingClientRect();
        const relY = e.clientY - rect.top;
        const relX = e.clientX - rect.left;
        row.classList.remove('drag-top', 'drag-bottom', 'drag-subtask');

        // Task drag indent threshold: >= 60% on mobile, >= 30% on PC
        const isMobile = window.innerWidth <= 768;
        const indentThreshold = isMobile ? 0.6 : 0.3;
        const isIndent = relX >= indentThreshold * rect.width;
        if (isIndent) {
          row.classList.add('drag-subtask');
        } else if (relY < rect.height / 2) {
          row.classList.add('drag-top');
        } else {
          row.classList.add('drag-bottom');
        }
      }
    });

    row.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && row.contains(e.relatedTarget)) return;
      row.classList.remove('drag-top', 'drag-bottom', 'drag-subtask');
    });

    row.addEventListener('drop', async (e) => {
      if (this.draggedTaskId && this.draggedTaskId !== task.id) {
        if (this.isTaskDescendant(task.id, this.draggedTaskId)) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = row.getBoundingClientRect();
        const relY = e.clientY - rect.top;
        const relX = e.clientX - rect.left;
        const isMobile = window.innerWidth <= 768;
        const indentThreshold = isMobile ? 0.6 : 0.3;
        const isIndent = relX >= indentThreshold * rect.width;
        row.classList.remove('drag-top', 'drag-bottom', 'drag-subtask');

        const movedTask = this.findTaskById(this.draggedTaskId);
        if (!movedTask) return;

        if (isIndent) {
          const removed = this.removeTaskFromParentTree(movedTask.id);
          if (!removed) return;
          removed.parent_id = task.id;
          removed.project_id = task.project_id;
          removed.section_id = task.section_id || null;
          const targetNode = this.findTaskById(task.id);
          if (targetNode) {
            if (!targetNode.subtasks) targetNode.subtasks = [];
            targetNode.subtasks.push(removed);
          }
          await this.saveTasksOrder(removed.id);
          return;
        }

        let newParentId = task.parent_id || null;
        let referenceTaskId = task.id;
        if (relX < 30 && movedTask.parent_id) {
          const currentParent = this.findTaskById(task.parent_id);
          newParentId = currentParent && currentParent.parent_id ? currentParent.parent_id : null;
          if (task.parent_id) {
            referenceTaskId = task.parent_id;
          }
        }

        const removed = this.removeTaskFromParentTree(movedTask.id);
        if (!removed) return;
        removed.parent_id = newParentId;
        removed.project_id = task.project_id;
        removed.section_id = task.section_id || null;

        let targetSiblings = this.tasks;
        if (newParentId) {
          const parentNode = this.findTaskById(newParentId);
          if (parentNode) {
            if (!parentNode.subtasks) parentNode.subtasks = [];
            targetSiblings = parentNode.subtasks;
          }
        }

        const targetIdx = targetSiblings.findIndex((t) => t.id === referenceTaskId);
        if (relY < rect.height / 2) {
          if (targetIdx !== -1) targetSiblings.splice(targetIdx, 0, removed);
          else targetSiblings.push(removed);
        } else {
          if (targetIdx !== -1) targetSiblings.splice(targetIdx + 1, 0, removed);
          else targetSiblings.push(removed);
        }

        await this.saveTasksOrder(removed.id);
      }
    });

    parentEl.appendChild(row);
    this.flattenedTasks.push(task);

    if (task.subtasks && task.subtasks.length > 0) {
      const subContainer = document.createElement('div');
      subContainer.className = 'subtasks-container';
      task.subtasks.forEach((st) => this.renderTaskRow(st, subContainer));
      parentEl.appendChild(subContainer);
    }
  }

  attachTaskDropTarget(container, defaultProps = {}) {
    container.addEventListener('dragover', (e) => {
      if (!this.draggedTaskId) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      container.classList.add('drag-over');
    });

    container.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && container.contains(e.relatedTarget)) return;
      container.classList.remove('drag-over');
    });

    container.addEventListener('drop', async (e) => {
      if (!this.draggedTaskId) return;
      e.preventDefault();
      e.stopPropagation();
      container.classList.remove('drag-over');
      document.body.classList.remove('is-dragging', 'dragging-task');
      const taskId = this.draggedTaskId || e.dataTransfer.getData('task-id');
      if (!taskId) return;

      const tasksToMove = this.selectedTaskIds && this.selectedTaskIds.has(taskId)
        ? Array.from(this.selectedTaskIds)
        : [taskId];

      const patch = {};
      if (defaultProps.dueDate !== undefined) patch.due_date = defaultProps.dueDate;
      if (defaultProps.projectId !== undefined) patch.project_id = defaultProps.projectId;
      if (defaultProps.sectionId !== undefined) patch.section_id = defaultProps.sectionId;

      for (const tId of tasksToMove) {
        const movedTask = this.findTaskById(tId);
        if (!movedTask) continue;
        const removed = this.removeTaskFromParentTree(tId);
        if (!removed) continue;
        removed.parent_id = null;
        if (defaultProps.dueDate !== undefined) removed.due_date = defaultProps.dueDate;
        if (defaultProps.projectId !== undefined) removed.project_id = defaultProps.projectId;
        if (defaultProps.sectionId !== undefined) removed.section_id = defaultProps.sectionId;

        this.tasks.push(removed);
        await this.saveTasksOrder(removed.id);
      }
      this.clearSelection();
      await this.loadTasks();
    });
  }

  // ----------------------------------------------------------------------
  // Unified Task Composer (Inline & Modal Quick Add)
  // ----------------------------------------------------------------------

  createComposerElement(options = {}) {
    const defaults = options.defaults || {};
    const onCancel = options.onCancel;
    const onSubmitted = options.onSubmitted;

    const composer = document.createElement('div');
    composer.className = 'inline-composer';
    composer._priorityManual = false;

    composer.innerHTML = `
      <input type="text" class="composer-title" placeholder="Task name" maxlength="500" />
      <div class="token-preview-chips composer-chips-preview"></div>
      <textarea class="composer-desc" rows="1" placeholder="Description..."></textarea>
      <div class="composer-bottom-bar">
        <div class="composer-chips-group">
          <div class="composer-chip-wrapper" style="position:relative;">
            <button type="button" class="composer-chip chip-date">${Icons.calendar} <span class="val">Due date</span></button>
            <div class="composer-popover popover-date cal-todoist-popover" style="display:none; width: 260px; z-index: 1200;">
              <div class="cal-quick-input-wrap">
                <input type="text" class="attr-input cal-quick-input" placeholder="Type a date" autocomplete="off" />
              </div>
              <div class="cal-quick-choices">
                <div class="popover-item cal-choice-item" data-action="today">
                  <span class="cal-choice-icon">${Icons.today}</span>
                  <span class="cal-choice-label">Today</span>
                  <span class="cal-choice-badge cal-badge-today"></span>
                </div>
                <div class="popover-item cal-choice-item" data-action="tomorrow">
                  <span class="cal-choice-icon">${Icons.tomorrow}</span>
                  <span class="cal-choice-label">Tomorrow</span>
                  <span class="cal-choice-badge cal-badge-tomorrow"></span>
                </div>
                <div class="popover-item cal-choice-item" data-action="weekend">
                  <span class="cal-choice-icon">${Icons.weekend}</span>
                  <span class="cal-choice-label">This weekend</span>
                  <span class="cal-choice-badge cal-badge-weekend"></span>
                </div>
                <div class="popover-item cal-choice-item" data-action="next-week">
                  <span class="cal-choice-icon">${Icons.nextWeek}</span>
                  <span class="cal-choice-label">Next week</span>
                  <span class="cal-choice-badge cal-badge-nextweek"></span>
                </div>
              </div>
              <div class="cal-divider"></div>
              <div class="composer-pc-calendar"></div>
              <div class="cal-divider"></div>
              <div class="popover-item cal-choice-item cal-nodate-item" data-action="clear">
                <span class="cal-choice-icon" style="color:var(--rp-love); font-weight:600;">✕</span>
                <span class="cal-choice-label">No date</span>
              </div>
            </div>
          </div>

          <div class="composer-chip-wrapper">
            <button type="button" class="composer-chip chip-priority">${Icons.flag} <span class="val">P3</span></button>
            <div class="composer-popover popover-priority" style="display:none; min-width: 160px;">
              <div class="mobile-sheet-header">
                <div class="detail-drag-handle"></div>
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; padding:0 4px;">
                  <h4 style="margin:0; font-size:1.05rem; font-weight:700; color:var(--rp-text);">Select Priority</h4>
                  <button type="button" class="btn-icon-subtle mobile-sheet-close" style="width:28px; height:28px; border-radius:50%; font-size:1.1rem; display:flex; align-items:center; justify-content:center; cursor:pointer; background:transparent; border:none; color:var(--rp-subtle);">&times;</button>
                </div>
              </div>
              <div class="popover-item" data-priority="1" style="display:flex; align-items:center; gap:8px; color:var(--rp-love); font-weight:600;"><span style="color:var(--rp-love); display:flex;">${Icons.flag}</span> <span>Priority 1 (Urgent)</span></div>
              <div class="popover-item" data-priority="2" style="display:flex; align-items:center; gap:8px; color:var(--rp-gold); font-weight:600;"><span style="color:var(--rp-gold); display:flex;">${Icons.flag}</span> <span>Priority 2 (High)</span></div>
              <div class="popover-item" data-priority="3" style="display:flex; align-items:center; gap:8px; color:var(--rp-foam); font-weight:600;"><span style="color:var(--rp-foam); display:flex;">${Icons.flag}</span> <span>Priority 3 (Normal)</span></div>
            </div>
          </div>

          <div class="composer-chip-wrapper">
            <button type="button" class="composer-chip chip-location">${Icons.pin} <span class="val">Location</span></button>
            <div class="composer-popover popover-location" style="display:none; min-width: 260px; width: 280px; overflow:visible;">
              <div class="mobile-sheet-header">
                <div class="detail-drag-handle"></div>
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; padding:0 4px;">
                  <h4 style="margin:0; font-size:1.05rem; font-weight:700; color:var(--rp-text);">Set Location</h4>
                  <button type="button" class="btn-icon-subtle mobile-sheet-close" style="width:28px; height:28px; border-radius:50%; font-size:1.1rem; display:flex; align-items:center; justify-content:center; cursor:pointer; background:transparent; border:none; color:var(--rp-subtle);">&times;</button>
                </div>
              </div>
              <div style="margin-bottom: 8px;">
                <input type="text" class="attr-input popover-loc-input" placeholder="Location or address..." style="width:100%; font-size:0.85rem; padding:8px 10px;" />
              </div>
              <div style="display:flex; justify-content:flex-end; gap:8px;">
                <button type="button" class="btn-secondary popover-loc-clear" style="font-size:0.8rem; padding:6px 12px;">Clear</button>
                <button type="button" class="btn-primary popover-loc-set" style="font-size:0.8rem; padding:6px 14px;">Set</button>
              </div>
            </div>
          </div>
        </div>
        <div class="composer-actions">
          <button type="button" class="btn-secondary btn-cancel">Cancel</button>
          <button type="button" class="btn-primary btn-submit" aria-label="Add task">
            <span class="btn-submit-label">Add task</span>
            <span class="btn-submit-icon">${Icons.arrowUp}</span>
          </button>
        </div>
      </div>
    `;

    const titleInput = composer.querySelector('.composer-title');
    const descInput = composer.querySelector('.composer-desc');
    const chipDateBtn = composer.querySelector('.chip-date');
    const chipDateVal = composer.querySelector('.chip-date .val');
    const popoverDate = composer.querySelector('.popover-date');
    const calQuickInput = popoverDate.querySelector('.cal-quick-input');
    const pcCalWrap = popoverDate.querySelector('.composer-pc-calendar');

    const chipPriorityBtn = composer.querySelector('.chip-priority');
    const chipPriorityVal = composer.querySelector('.chip-priority .val');
    const popoverPriority = composer.querySelector('.popover-priority');

    const chipLocBtn = composer.querySelector('.chip-location');
    const chipLocVal = composer.querySelector('.chip-location .val');
    const popoverLocation = composer.querySelector('.popover-location');
    const locInput = composer.querySelector('.popover-loc-input');
    const locClearBtn = composer.querySelector('.popover-loc-clear');
    const locSetBtn = composer.querySelector('.popover-loc-set');

    if (defaults.priority) composer.dataset.priority = defaults.priority;
    if (defaults.dueDate) composer.dataset.dueDate = defaults.dueDate;
    if (defaults.recurrence) composer.dataset.recurrence = defaults.recurrence;
    if (defaults.location) composer.dataset.location = defaults.location;
    if (defaults.sectionId) composer.dataset.sectionId = defaults.sectionId;
    if (defaults.projectId) composer.dataset.projectId = defaults.projectId;
    if (defaults.parentId) composer.dataset.parentId = defaults.parentId;

    let parsedState = {
      dueDate: defaults.dueDate || null,
      explicitlyClearedDate: false,
      priority: defaults.priority || 3,
      location: defaults.location || null,
      explicitlyClearedLocation: false,
      projectId: defaults.projectId || this.currentProjectId || 'inbox',
      sectionId: defaults.sectionId || null,
    };

    const formatDueLabel = (dStr) => {
      if (!dStr) return 'Due date';
      const clean = dStr.slice(0, 10);
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
      const tom = new Date(now);
      tom.setDate(tom.getDate() + 1);
      const tomStr = `${tom.getFullYear()}-${pad2(tom.getMonth() + 1)}-${pad2(tom.getDate())}`;

      if (clean === todayStr) return 'Today';
      if (clean === tomStr) return 'Tomorrow';
      return clean;
    };

    if (parsedState.dueDate) {
      composer.dataset.dueDate = parsedState.dueDate;
      chipDateVal.textContent = formatDueLabel(parsedState.dueDate);
      chipDateBtn.classList.add('has-value');
    }
    composer.dataset.priority = parsedState.priority;
    chipPriorityVal.textContent = `P${parsedState.priority}`;
    chipPriorityBtn.classList.add(`p${parsedState.priority}`, 'has-value');

    if (parsedState.location) {
      composer.dataset.location = parsedState.location;
      chipLocVal.textContent = parsedState.location.length > 20 ? parsedState.location.slice(0, 18) + '...' : parsedState.location;
      chipLocBtn.classList.add('has-value');
      if (locInput) locInput.value = parsedState.location;
    }

    const allPopovers = [popoverDate, popoverPriority, popoverLocation];
    const closeAllPopovers = () => {
      allPopovers.forEach((p) => { p.style.display = 'none'; });
      this.hideMobileBackdrop();
    };

    composer.querySelectorAll('.mobile-sheet-close').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllPopovers();
      });
    });

    const isAnyPopoverOpen = () => {
      return allPopovers.some((p) => p.style.display === 'block');
    };

    const togglePopover = (targetPopover, focusEl) => {
      const willOpen = targetPopover.style.display !== 'block';
      closeAllPopovers();
      if (willOpen) {
        targetPopover.style.display = 'block';

        const isMobile = window.innerWidth <= 768;
        if (isMobile) {
          this.showMobileBackdrop(() => closeAllPopovers());
        } else {
          const wrapperRect = targetPopover.parentElement?.getBoundingClientRect() || { bottom: 0 };
          const spaceBelow = window.innerHeight - wrapperRect.bottom;
          const isBottomPinned = !!composer.closest('#modal-quick-add-container') || spaceBelow < 220;

          if (isBottomPinned) {
            targetPopover.style.top = 'auto';
            targetPopover.style.bottom = 'calc(100% + 8px)';
          } else {
            targetPopover.style.top = 'calc(100% + 4px)';
            targetPopover.style.bottom = 'auto';
          }

          const popoverRect = targetPopover.getBoundingClientRect();
          if (popoverRect.right > window.innerWidth - 12) {
            targetPopover.style.left = 'auto';
            targetPopover.style.right = '0px';
          } else {
            targetPopover.style.left = '0px';
            targetPopover.style.right = 'auto';
          }
        }

        if (focusEl) {
          setTimeout(() => focusEl.focus(), 50);
        }
      }
    };

    titleInput.addEventListener('focus', () => closeAllPopovers());
    descInput.addEventListener('focus', () => closeAllPopovers());

    const handleDocClick = (e) => {
      if (!composer.contains(e.target)) {
        closeAllPopovers();
      }
    };
    document.addEventListener('click', handleDocClick);

    // Due date setting helper
    const setComposerDueDate = (selectedDate) => {
      if (selectedDate) {
        composer.dataset.dueDate = selectedDate;
        parsedState.dueDate = selectedDate;
        parsedState.explicitlyClearedDate = false;
        chipDateVal.textContent = formatDueLabel(selectedDate);
        chipDateBtn.classList.add('has-value');
      } else {
        delete composer.dataset.dueDate;
        parsedState.dueDate = null;
        parsedState.explicitlyClearedDate = true;
        chipDateVal.textContent = 'Due date';
        chipDateBtn.classList.remove('has-value');
      }
      const mobPop = document.getElementById('mobile-due-date-popover');
      const isMobPopOpen = mobPop && mobPop.style.display === 'block';
      if (!isMobPopOpen) {
        closeAllPopovers();
        titleInput.focus();
      }
    };

    // Due date button and popover
    attachSingleTap(chipDateBtn, (e) => {
      const isMobile = window.innerWidth <= 768;
      if (isMobile) {
        closeAllPopovers();
        this.openMobileDateSheet(composer.dataset.dueDate || parsedState.dueDate, (newDate) => {
          setComposerDueDate(newDate);
        });
      } else {
        const willOpen = popoverDate.style.display !== 'block';
        togglePopover(popoverDate);
        if (willOpen) {
          this.updateQuickChoiceBadges(popoverDate);
          if (pcCalWrap) {
            renderRosePineCalendar(pcCalWrap, composer.dataset.dueDate || parsedState.dueDate, (iso) => {
              setComposerDueDate(iso);
            });
          }
          if (calQuickInput) {
            calQuickInput.value = '';
            requestAnimationFrame(() => calQuickInput.focus());
          }
        }
      }
    });

    calQuickInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const val = calQuickInput.value.trim();
        if (!val) return;
        if (/^(no date|none|clear)$/i.test(val)) {
          setComposerDueDate(null);
          return;
        }
        const parsed = parseQuickTokens(val, new Date());
        if (parsed && parsed.dueDate) {
          setComposerDueDate(parsed.dueDate);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeAllPopovers();
        titleInput.focus();
      }
    });

    popoverDate.querySelectorAll('.cal-choice-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = item.dataset.action;
        const now = new Date();
        let dStr = null;
        if (action === 'today') {
          dStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
        } else if (action === 'tomorrow') {
          const tom = new Date(now);
          tom.setDate(tom.getDate() + 1);
          dStr = `${tom.getFullYear()}-${pad2(tom.getMonth() + 1)}-${pad2(tom.getDate())}`;
        } else if (action === 'weekend') {
          const curDay = now.getDay();
          let diffSat = 6 - curDay;
          if (diffSat <= 0) diffSat += 7;
          const sat = new Date(now);
          sat.setDate(now.getDate() + diffSat);
          dStr = `${sat.getFullYear()}-${pad2(sat.getMonth() + 1)}-${pad2(sat.getDate())}`;
        } else if (action === 'next-week') {
          const curDay = now.getDay();
          let diffMon = (1 - curDay + 7) % 7;
          if (diffMon === 0) diffMon = 7;
          const nextMon = new Date(now);
          nextMon.setDate(now.getDate() + diffMon);
          dStr = `${nextMon.getFullYear()}-${pad2(nextMon.getMonth() + 1)}-${pad2(nextMon.getDate())}`;
        } else if (action === 'clear') {
          dStr = null;
        }
        setComposerDueDate(dStr);
      });
    });

    // Priority button and popover
    const setComposerPriority = (p) => {
      const pri = parseInt(p, 10) || 3;
      composer.dataset.priority = pri;
      composer._priorityManual = true;
      parsedState.priority = pri;
      chipPriorityVal.textContent = `P${pri}`;
      chipPriorityBtn.className = `composer-chip chip-priority p${pri} has-value`;
      closeAllPopovers();
      titleInput.focus();
    };

    attachSingleTap(chipPriorityBtn, (e) => {
      const isMobile = window.innerWidth <= 768;
      if (isMobile) {
        closeAllPopovers();
        this.openMobilePrioritySheet(composer.dataset.priority || parsedState.priority, (p) => {
          setComposerPriority(p);
        });
      } else {
        togglePopover(popoverPriority);
      }
    });

    popoverPriority.querySelectorAll('.popover-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        setComposerPriority(item.dataset.priority);
      });
    });

    // Location button and popover
    const setComposerLocation = (loc) => {
      if (loc) {
        composer.dataset.location = loc;
        parsedState.location = loc;
        parsedState.explicitlyClearedLocation = false;
        chipLocVal.textContent = loc.length > 20 ? loc.slice(0, 18) + '...' : loc;
        chipLocBtn.classList.add('has-value');
        if (locInput) locInput.value = loc;
      } else {
        delete composer.dataset.location;
        parsedState.location = null;
        parsedState.explicitlyClearedLocation = true;
        chipLocVal.textContent = 'Location';
        chipLocBtn.classList.remove('has-value');
        if (locInput) locInput.value = '';
      }
      closeAllPopovers();
      titleInput.focus();
    };

    attachSingleTap(chipLocBtn, (e) => {
      const isMobile = window.innerWidth <= 768;
      if (isMobile) {
        closeAllPopovers();
        this.openMobileLocationSheet(composer.dataset.location || parsedState.location, (loc) => {
          setComposerLocation(loc);
        });
      } else {
        togglePopover(popoverLocation, locInput);
      }
    });

    locSetBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      setComposerLocation(locInput ? locInput.value.trim() : '');
    });

    locClearBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      setComposerLocation(null);
    });

    locInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        locSetBtn.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeAllPopovers();
        titleInput.focus();
      }
    });

    titleInput.setAttribute('maxlength', '500');

    const handleTitleOverflow = () => {
      if (titleInput.value.length > 500) {
        const full = titleInput.value;
        titleInput.value = full.slice(0, 500);
        const remainder = full.slice(500);
        if (descInput) {
          descInput.value = descInput.value ? (descInput.value + '\n' + remainder) : remainder;
        }
      }
    };

    titleInput.addEventListener('paste', (e) => {
      const paste = (e.clipboardData || window.clipboardData)?.getData('text');
      if (!paste) return;
      const current = titleInput.value;
      const start = titleInput.selectionStart || 0;
      const end = titleInput.selectionEnd || 0;
      const combined = current.slice(0, start) + paste + current.slice(end);
      if (combined.length > 500) {
        e.preventDefault();
        titleInput.value = combined.slice(0, 500);
        const remainder = combined.slice(500);
        if (descInput) {
          descInput.value = descInput.value ? (descInput.value + '\n' + remainder) : remainder;
        }
        titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    const previewContainer = composer.querySelector('.composer-chips-preview');
    const ignoredTokens = new Set();
    composer._ignoredTokens = ignoredTokens;

    const updateComposerTokens = () => {
      const tokens = parseQuickTokens(titleInput.value, new Date(), ignoredTokens);
      renderPreviewBadges(tokens, previewContainer, (tokenToDismiss) => {
        ignoredTokens.add(tokenToDismiss.type);
        if (tokenToDismiss.type === 'date') {
          parsedState.explicitlyClearedDate = true;
          parsedState.dueDate = null;
          delete composer.dataset.dueDate;
          chipDateVal.textContent = 'Date';
          chipDateBtn.classList.remove('has-value');
        } else if (tokenToDismiss.type === 'priority') {
          parsedState.priority = defaults.priority || 3;
          delete composer.dataset.priority;
          composer._priorityManual = false;
          chipPriorityVal.textContent = 'Priority';
          chipPriorityBtn.classList.remove('p1', 'p2', 'p3', 'has-value');
        } else if (tokenToDismiss.type === 'location') {
          parsedState.explicitlyClearedLocation = true;
          parsedState.location = null;
          delete composer.dataset.location;
          locInput.value = '';
          chipLocVal.textContent = 'Location';
          chipLocBtn.classList.remove('has-value');
        } else if (tokenToDismiss.type === 'recurr' || tokenToDismiss.type === 'recurrence') {
          parsedState.recurrence = null;
          delete composer.dataset.recurrence;
        } else if (tokenToDismiss.type === 'project') {
          parsedState.projectId = defaults.projectId || this.currentProjectId || 'inbox';
        }
        updateComposerTokens();
      });

      if (!ignoredTokens.has('date')) {
        if (tokens.dueDateLabel && !parsedState.explicitlyClearedDate) {
          chipDateVal.textContent = tokens.dueDateLabel;
          chipDateBtn.classList.add('has-value');
          if (tokens.dueDate) parsedState.dueDate = tokens.dueDate;
        }
      }
      if (!ignoredTokens.has('priority')) {
        if (tokens.priority && tokens.priority <= 3) {
          chipPriorityVal.textContent = `P${tokens.priority}`;
          parsedState.priority = tokens.priority;
          chipPriorityBtn.classList.remove('p1', 'p2', 'p3');
          chipPriorityBtn.classList.add(`p${tokens.priority}`, 'has-value');
        }
      }
      if (!ignoredTokens.has('location')) {
        if (tokens.location && !parsedState.explicitlyClearedLocation) {
          chipLocVal.textContent = tokens.location.length > 20 ? tokens.location.slice(0, 18) + '...' : tokens.location;
          parsedState.location = tokens.location;
          chipLocBtn.classList.add('has-value');
          locInput.value = tokens.location;
        }
      }
      if (!ignoredTokens.has('project')) {
        if (tokens.project) {
          const found = this.projects?.find((p) => p.name.toLowerCase() === tokens.project.toLowerCase());
          if (found) parsedState.projectId = found.id;
        }
      }
    };

    // Quick token typing in title
    titleInput.addEventListener('input', () => {
      handleTitleOverflow();
      updateComposerTokens();
    });

    const destroy = () => {
      closeAllPopovers();
      document.removeEventListener('click', handleDocClick);
      composer.remove();
      this.vim.setMode('NORMAL');
    };

    const cancel = () => {
      destroy();
      if (onCancel) onCancel();
    };

    let isSubmitting = false;
    const submit = async () => {
      if (isSubmitting) return;
      isSubmitting = true;
      closeAllPopovers();
      try {
        await this.submitComposerTask(composer);
      } finally {
        isSubmitting = false;
      }
    };

    const submitBtn = composer.querySelector('.btn-submit');
    submitBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    submitBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      submit();
    }, { passive: false });
    submitBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      submit();
    });

    composer.querySelector('.btn-cancel').addEventListener('click', (e) => {
      e.stopPropagation();
      cancel();
    });

    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (isAnyPopoverOpen()) {
          closeAllPopovers();
        } else {
          cancel();
        }
      }
    });

    descInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (isAnyPopoverOpen()) {
          closeAllPopovers();
        } else {
          cancel();
        }
      }
    });

    Object.defineProperty(composer, 'currentDueDate', {
      get: () => composer.dataset.dueDate || parsedState.dueDate,
      set: (val) => {
        if (val) composer.dataset.dueDate = val; else delete composer.dataset.dueDate;
        parsedState.dueDate = val;
        chipDateVal.textContent = formatDueLabel(val);
        if (val) chipDateBtn.classList.add('has-value'); else chipDateBtn.classList.remove('has-value');
      },
      configurable: true,
      enumerable: true,
    });
    Object.defineProperty(composer, 'currentPriority', {
      get: () => parseInt(composer.dataset.priority, 10) || parsedState.priority,
      set: (val) => {
        const p = parseInt(val, 10) || 3;
        composer.dataset.priority = p;
        composer._priorityManual = true;
        parsedState.priority = p;
        chipPriorityVal.textContent = `P${p}`;
        chipPriorityBtn.className = `composer-chip chip-priority p${p} has-value`;
      },
      configurable: true,
      enumerable: true,
    });
    Object.defineProperty(composer, 'currentLocation', {
      get: () => composer.dataset.location || parsedState.location,
      set: (val) => {
        if (val) composer.dataset.location = val; else delete composer.dataset.location;
        parsedState.location = val;
        chipLocVal.textContent = val ? (val.length > 20 ? val.slice(0, 18) + '...' : val) : 'Location';
        if (val) chipLocBtn.classList.add('has-value'); else chipLocBtn.classList.remove('has-value');
      },
      configurable: true,
      enumerable: true,
    });

    composer.submitComposerTask = submit;
    composer.handleQuickAddSubmit = submit;
    composer._onSubmitted = onSubmitted;
    composer._cancel = cancel;
    composer._destroy = destroy;

    return composer;
  }

  openInlineComposer(sectionBlock, taskList, defaults = {}) {
    document.querySelectorAll('.inline-composer').forEach((c) => c.remove());

    const composer = this.createComposerElement({
      defaults,
      isModal: false,
      onCancel: () => {
        this.vim.setMode('NORMAL');
      },
    });

    if (defaults.insertAfterEl) {
      defaults.insertAfterEl.after(composer);
    } else {
      taskList.after(composer);
    }

    const titleInput = composer.querySelector('.composer-title');
    if (titleInput) {
      titleInput.focus();
      this.vim.setMode('INSERT');
    }
  }


  syncDetailDateLabel(dStr) {
    const label = document.getElementById('detail-due-date-label');
    const icon = document.getElementById('detail-due-date-icon');
    const mobLabel = document.getElementById('mobile-date-label');
    const mobIcon = document.getElementById('mobile-date-icon');

    if (!dStr) {
      if (label) label.textContent = 'No date';
      if (icon) icon.innerHTML = Icons.calendar;
      if (mobLabel) mobLabel.textContent = 'Date';
      if (mobIcon) mobIcon.innerHTML = Icons.calendar;
      return;
    }

    const clean = dStr.slice(0, 10);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const tom = new Date(now);
    tom.setDate(tom.getDate() + 1);
    const tomStr = tom.toISOString().slice(0, 10);

    let text = clean;
    let mobText = clean;
    let iconSvg = Icons.calendar;

    if (clean === todayStr) {
      text = 'Today';
      mobText = 'Today';
      iconSvg = Icons.today;
    } else if (clean === tomStr) {
      text = 'Tomorrow';
      mobText = 'Tomorrow';
      iconSvg = Icons.tomorrow;
    }

    if (label) label.textContent = text;
    if (icon) icon.innerHTML = iconSvg;

    const recVal = document.getElementById('detail-recurrence-select')?.value || document.getElementById('mobile-recurrence-select')?.value;
    if (recVal) {
      if (mobLabel) mobLabel.innerHTML = `${mobText} <span style="display:inline-flex; vertical-align:middle; margin-left:4px; color:var(--rp-foam);">${Icons.repeat}</span>`;
    } else {
      if (mobLabel) mobLabel.textContent = mobText;
    }
    if (mobIcon) mobIcon.innerHTML = iconSvg;
  }

  updateQuickChoiceBadges(container = document) {
    const now = new Date();
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const getEl = (selector) => {
      if (container && typeof container.querySelector === 'function') {
        const found = container.querySelector(selector);
        if (found) return found;
      }
      return document.querySelector(selector);
    };

    // Today badge: current weekday, e.g. Thu
    const todayBadge = getEl('#cal-badge-today, .cal-badge-today');
    if (todayBadge) {
      todayBadge.textContent = dayNames[now.getDay()];
    }

    // Tomorrow badge: tomorrow's weekday, e.g. Fri
    const tom = new Date(now);
    tom.setDate(now.getDate() + 1);
    const tomBadge = getEl('#cal-badge-tomorrow, .cal-badge-tomorrow');
    if (tomBadge) {
      tomBadge.textContent = dayNames[tom.getDay()];
    }

    // This weekend badge: upcoming Saturday, e.g. Sat
    const curDay = now.getDay();
    let diffSat = 6 - curDay;
    if (diffSat <= 0) diffSat += 7;
    const sat = new Date(now);
    sat.setDate(now.getDate() + diffSat);
    const satBadge = getEl('#cal-badge-weekend, .cal-badge-weekend');
    if (satBadge) {
      satBadge.textContent = dayNames[sat.getDay()];
    }

    // Next week badge: next Monday date, e.g. Mon Oct 19
    let diffMon = (1 - curDay + 7) % 7;
    if (diffMon === 0) diffMon = 7;
    const nextMon = new Date(now);
    nextMon.setDate(now.getDate() + diffMon);
    const nextMonBadge = getEl('#cal-badge-nextweek, .cal-badge-nextweek');
    if (nextMonBadge) {
      nextMonBadge.textContent = `${dayNames[nextMon.getDay()]} ${monthNames[nextMon.getMonth()]} ${nextMon.getDate()}`;
    }
  }

  // ----------------------------------------------------------------------
  // Task Detail Modal
  // ----------------------------------------------------------------------

  async openTaskDetailModal(task, previousParentTask = null, isNavigatingBack = false) {
    if (!task) return;

    const modal = document.getElementById('modal-task-detail');
    const isAlreadyOpen = modal && modal.classList.contains('open');

    if (!isAlreadyOpen) {
      this.taskDetailHistory = [];
    } else if (!isNavigatingBack && this.activeTaskDetail && this.activeTaskDetail.id !== task.id) {
      await this.saveActiveDetailTask();
      this.taskDetailHistory.push(this.activeTaskDetail);
    }

    let freshTask = task;
    try {
      const fetched = await this.fetchTask(task.id);
      if (fetched) freshTask = fetched;
    } catch (err) {
      console.error('Error fetching task details', err);
    }
    this.activeTaskDetail = freshTask;
    document.body.classList.add('modal-open');
    const detailModal = modal?.querySelector('.detail-modal');
    if (detailModal) {
      detailModal.classList.remove('expanded');
      detailModal.style.transform = '';
      detailModal.style.transition = '';
    }

    // Back button and close button handling
    const backBtn = document.getElementById('detail-btn-back');
    const closeBtn = document.getElementById('detail-btn-close');
    const parentTitleEl = document.getElementById('detail-parent-title');

    const hasParent = !!freshTask.parent_id;
    const hasHistory = this.taskDetailHistory && this.taskDetailHistory.length > 0;

    if (backBtn && parentTitleEl) {
      if (hasParent || hasHistory) {
        let parentTask = previousParentTask;
        if (!parentTask && hasHistory) {
          parentTask = this.taskDetailHistory[this.taskDetailHistory.length - 1];
        }
        if ((!parentTask || (hasParent && parentTask.id !== freshTask.parent_id)) && hasParent) {
          try {
            parentTask = await this.fetchTask(freshTask.parent_id);
          } catch (e) {
            console.error(e);
          }
        }
        backBtn.style.display = 'inline-flex';
        parentTitleEl.textContent = parentTask?.title || 'Parent';
        backBtn.onclick = async (e) => {
          e.stopPropagation();
          await this.navigateBackDetailTask();
        };

        if (closeBtn) closeBtn.style.display = 'inline-flex';
      } else {
        backBtn.style.display = 'none';
        backBtn.onclick = null;
        if (closeBtn) closeBtn.style.display = 'inline-flex';
      }
    }

    const titleInput = document.getElementById('detail-title');
    const descInput = document.getElementById('detail-desc');
    const tokenChips = document.getElementById('detail-token-chips');

    if (titleInput) {
      titleInput.value = freshTask.title;
      titleInput.style.height = 'auto';
      titleInput.style.height = `${titleInput.scrollHeight}px`;
    }
    if (descInput) {
      descInput.value = freshTask.description || '';
      descInput.style.height = 'auto';
      descInput.style.height = `${Math.max(60, descInput.scrollHeight)}px`;
    }
    if (tokenChips) {
      tokenChips.innerHTML = '';
      tokenChips.style.display = 'none';
    }

    // Description visibility (permanently visible)
    const descContainer = document.getElementById('detail-desc-container');
    if (descContainer) {
      descContainer.style.display = 'block';
    }

    const dVal = freshTask.due_date ? freshTask.due_date.slice(0, 10) : '';
    document.getElementById('detail-due-date').value = dVal;
    const picker = document.getElementById('detail-due-date-picker');
    if (picker) picker.value = dVal;
    const mobPicker = document.getElementById('mobile-due-date-picker');
    if (mobPicker) mobPicker.value = dVal;
    this.syncDetailDateLabel(dVal);
    const pop = document.getElementById('detail-due-date-popover');
    if (pop) pop.style.display = 'none';
    const calQuickIn = document.getElementById('cal-quick-input');
    if (calQuickIn) calQuickIn.value = '';
    const mobPop = document.getElementById('mobile-due-date-popover');
    if (mobPop) mobPop.style.display = 'none';

    const priVal = freshTask.priority || 3;
    document.getElementById('detail-priority-select').value = priVal;
    this.syncPriorityDisplay(priVal);

    // Location
    const deskLoc = document.getElementById('detail-location-input');
    if (deskLoc) deskLoc.value = freshTask.location || '';
    const mobLoc = document.getElementById('mobile-location-input');
    if (mobLoc) mobLoc.value = freshTask.location || '';
    const mapsLink = document.getElementById('detail-location-maps-link');
    if (mapsLink) {
      const hasLocation = !!(freshTask.location && freshTask.location.trim());
      mapsLink.style.display = hasLocation ? 'inline-flex' : 'none';
      if (hasLocation) {
        mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(freshTask.location.trim())}`;
      }
    }

    // Schedule & Recurrence (Unified parameter)
    const recSelect = document.getElementById('detail-recurrence-select');
    const cronBox = document.getElementById('detail-cron-box');
    const cronInput = document.getElementById('detail-cron-input');

    const rawRec = freshTask.recurrence || '';
    if (rawRec.startsWith('cron:')) {
      recSelect.value = 'custom';
      cronBox.style.display = 'flex';
      cronInput.value = rawRec.slice(5);
    } else if (['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(rawRec)) {
      recSelect.value = rawRec;
      cronBox.style.display = 'none';
      cronInput.value = '';
    } else if (rawRec) {
      recSelect.value = 'custom';
      cronBox.style.display = 'flex';
      cronInput.value = rawRec;
    } else {
      recSelect.value = '';
      cronBox.style.display = 'none';
      cronInput.value = '';
    }

    const mobRecSelect = document.getElementById('mobile-recurrence-select');
    const mobCronBox = document.getElementById('mobile-cron-box');
    const mobCronInput = document.getElementById('mobile-cron-input');
    if (mobRecSelect) {
      mobRecSelect.value = recSelect.value;
      if (mobCronBox) mobCronBox.style.display = recSelect.value === 'custom' ? 'flex' : 'none';
      if (mobCronInput) mobCronInput.value = cronInput.value;
    }

    this.syncRecurrenceDisplay(recSelect.value);
    this.updateSchedulePreview();

    recSelect.onchange = () => {
      cronBox.style.display = recSelect.value === 'custom' ? 'flex' : 'none';
      this.syncRecurrenceDisplay(recSelect.value);
      this.updateSchedulePreview();
    };
    cronInput.oninput = () => this.updateSchedulePreview();
    document.getElementById('detail-due-date').onchange = () => this.updateSchedulePreview();

    // Projects Select & PC Popover
    const projSelect = document.getElementById('detail-project-select');
    const mobProjSelect = document.getElementById('mobile-project-select');
    const projPopover = document.getElementById('detail-project-custom-popover');
    if (projSelect) projSelect.innerHTML = '';
    if (mobProjSelect) mobProjSelect.innerHTML = '';
    if (projPopover) projPopover.innerHTML = '';

    const inboxOpt = document.createElement('option');
    inboxOpt.value = 'inbox';
    inboxOpt.textContent = 'Inbox';
    if (!freshTask.project_id || freshTask.project_id === 'inbox') inboxOpt.selected = true;
    projSelect?.appendChild(inboxOpt);
    mobProjSelect?.appendChild(inboxOpt.cloneNode(true));

    if (projPopover) {
      const inboxItem = document.createElement('div');
      inboxItem.className = `popover-item ${(!freshTask.project_id || freshTask.project_id === 'inbox') ? 'selected' : ''}`;
      inboxItem.dataset.value = 'inbox';
      inboxItem.innerHTML = `${Icons.inbox} <span>Inbox</span>`;
      inboxItem.addEventListener('click', () => {
        projSelect.value = 'inbox';
        projSelect.dispatchEvent(new Event('change'));
        this.syncProjectDisplay('inbox', 'Inbox');
        projPopover.style.display = 'none';
      });
      projPopover.appendChild(inboxItem);
    }

    const addProjOptions = (projs, depth = 0) => {
      if (!Array.isArray(projs)) return;
      projs.forEach((p) => {
        if (!p || p.id === 'inbox') return;
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${'  '.repeat(depth)}# ${p.name}`;
        if (p.id === freshTask.project_id) opt.selected = true;
        projSelect?.appendChild(opt);
        mobProjSelect?.appendChild(opt.cloneNode(true));

        if (projPopover) {
          const item = document.createElement('div');
          item.className = `popover-item ${p.id === freshTask.project_id ? 'selected' : ''}`;
          item.dataset.value = p.id;
          item.style.paddingLeft = `${10 + depth * 14}px`;
          item.innerHTML = `${Icons.hash} <span>${p.name}</span>`;
          item.addEventListener('click', () => {
            projSelect.value = p.id;
            projSelect.dispatchEvent(new Event('change'));
            this.syncProjectDisplay(p.id, p.name);
            projPopover.style.display = 'none';
          });
          projPopover.appendChild(item);
        }
        if (p.children && Array.isArray(p.children)) addProjOptions(p.children, depth + 1);
      });
    };
    addProjOptions(this.projects || []);

    this.syncProjectDisplay(freshTask.project_id, freshTask.project_name);
    await this.updateDetailSectionOptions(freshTask.project_id, freshTask.section_id);

    const titleCheck = document.getElementById('detail-title-check');
    if (titleCheck) titleCheck.innerHTML = Icons.check;

    this.renderDetailSubtasks(freshTask);
    modal.classList.add('open');

    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    const pcCalWrap = document.getElementById('detail-pc-calendar');
    const touchPickerWrap = document.getElementById('detail-touch-picker-wrap');
    if (pcCalWrap && touchPickerWrap) {
      if (isTouch) {
        pcCalWrap.style.display = 'none';
        touchPickerWrap.style.display = 'block';
      } else {
        touchPickerWrap.style.display = 'none';
        pcCalWrap.style.display = 'block';
        renderRosePineCalendar(pcCalWrap, dVal, (iso) => {
          document.getElementById('detail-due-date').value = iso;
          const p = document.getElementById('detail-due-date-picker');
          if (p) p.value = iso;
          this.syncDetailDateLabel(iso);
          const popover = document.getElementById('detail-due-date-popover');
          if (popover) popover.style.display = 'none';
        });
      }
    }

    this.detailModalInitialState = this.getDetailModalCurrentState();
    this.initialModalTitle = freshTask.title || '';
    this.initialDetailTitle = this.initialModalTitle;
    this.initialDetailDesc = freshTask.description || '';
    this.isTitleEditing = false;
    this.isDescEditing = false;
    this.activeSubtaskInput = false;
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    this.vim?.setMode('NORMAL');
    this.detailIgnoredTokens = new Set();
    const detailTokenChips = document.getElementById('detail-token-chips');
    if (detailTokenChips) {
      detailTokenChips.innerHTML = '';
      detailTokenChips.style.display = 'none';
    }
    // Enter 1: #detail-title is NOT yet focused (remains in modal inspection state)
  }

  syncProjectDisplay(id, name) {
    const displayName = (id === 'inbox' || !id) ? 'Inbox' : (name || 'Inbox');
    const pcLabel = document.getElementById('detail-project-custom-label');
    if (pcLabel) pcLabel.textContent = (id === 'inbox' || !id) ? 'Inbox' : `# ${displayName}`;
    const mobLabel = document.getElementById('mobile-project-label');
    if (mobLabel) mobLabel.textContent = (id === 'inbox' || !id) ? 'Inbox' : displayName;
    const mobSelect = document.getElementById('mobile-project-select');
    if (mobSelect && mobSelect.value !== id) mobSelect.value = id || 'inbox';
  }

  syncSectionDisplay(id, name) {
    const pcLabel = document.getElementById('detail-section-custom-label');
    if (pcLabel) pcLabel.textContent = name || '(No section)';
  }

  syncPriorityDisplay(val) {
    const p = String(val || '3');
    const colors = { '1': 'var(--rp-love)', '2': 'var(--rp-gold)', '3': 'var(--rp-foam)' };
    const color = colors[p] || 'var(--rp-foam)';

    const pcLabel = document.getElementById('detail-priority-custom-label');
    if (pcLabel) {
      pcLabel.innerHTML = `
        <span class="priority-dot" style="width:8px; height:8px; border-radius:50%; background:${color};"></span>
        <span>P${p}</span>
      `;
    }

    const mobChip = document.getElementById('mobile-chip-priority');
    const mobLabel = document.getElementById('mobile-chip-priority-label');
    if (mobChip && mobLabel) {
      mobChip.classList.remove('p1', 'p2', 'p3');
      mobChip.classList.add(`p${p}`);
      mobLabel.textContent = `P${p}`;
    }

    const mobSelect = document.getElementById('mobile-priority-select');
    if (mobSelect && mobSelect.value !== p) mobSelect.value = p;
  }

  closeAllDetailPopovers(except = null) {
    const popovers = [
      document.getElementById('detail-project-custom-popover'),
      document.getElementById('detail-section-custom-popover'),
      document.getElementById('detail-priority-custom-popover'),
      document.getElementById('detail-recurrence-custom-popover'),
      document.getElementById('detail-due-date-popover'),
      document.getElementById('mobile-due-date-popover'),
    ];
    popovers.forEach((p) => {
      if (p && p !== except) {
        p.style.display = 'none';
        p.classList.remove('open');
      }
    });
  }

  syncRecurrenceDisplay(val) {
    const map = {
      '': 'No recurrence',
      daily: 'Daily (Every day)',
      weekdays: 'Weekdays (Mon - Fri)',
      weekly: 'Weekly',
      monthly: 'Monthly',
      yearly: 'Yearly',
      custom: 'Custom Cron Expression',
    };
    const label = map[val] || (val ? `Cron: ${val}` : 'No recurrence');
    const triggerLabel = document.getElementById('detail-recurrence-custom-label');
    if (triggerLabel) triggerLabel.textContent = label;

    const popover = document.getElementById('detail-recurrence-custom-popover');
    if (popover) {
      popover.querySelectorAll('.popover-item').forEach((item) => {
        item.classList.toggle('selected', item.dataset.value === (val || ''));
      });
    }

    const mobRec = document.getElementById('mobile-recurrence-select');
    if (mobRec && mobRec.value !== (val || '')) {
      mobRec.value = val || '';
    }
  }

  updateSchedulePreview() {
    const dueDate = document.getElementById('detail-due-date').value;
    const recVal = document.getElementById('detail-recurrence-select').value;
    const cronVal = document.getElementById('detail-cron-input').value.trim();
    const preview = document.getElementById('detail-schedule-preview');
    if (!preview) return;

    if (!dueDate && !recVal) {
      preview.style.display = 'none';
      return;
    }

    let text = '';
    if (recVal === 'custom' && cronVal) {
      text = `🔄 Cron: ${cronVal}`;
    } else if (recVal === 'weekdays') {
      text = '🔄 Repeats weekdays (Mon - Fri)';
    } else if (recVal === 'daily') {
      text = '🔄 Repeats daily';
    } else if (recVal === 'weekly') {
      text = '🔄 Repeats weekly';
    } else if (recVal === 'monthly') {
      text = '🔄 Repeats monthly';
    } else if (recVal === 'yearly') {
      text = '🔄 Repeats yearly';
    }

    if (dueDate) {
      text = text ? `📅 ${dueDate} • ${text}` : `📅 Due ${dueDate}`;
    }

    preview.textContent = text;
    preview.style.display = 'block';
  }

  async updateDetailSectionOptions(projectId, selectedSectionId = null) {
    const secSelect = document.getElementById('detail-section-select');
    const secPopover = document.getElementById('detail-section-custom-popover');
    if (secSelect) secSelect.innerHTML = '<option value="">(No section)</option>';
    if (secPopover) secPopover.innerHTML = '';

    const noneItem = document.createElement('div');
    noneItem.className = `popover-item ${!selectedSectionId ? 'selected' : ''}`;
    noneItem.dataset.value = '';
    noneItem.textContent = '(No section)';
    noneItem.addEventListener('click', () => {
      if (secSelect) {
        secSelect.value = '';
        secSelect.dispatchEvent(new Event('change'));
      }
      this.syncSectionDisplay('', '(No section)');
      if (secPopover) secPopover.style.display = 'none';
    });
    secPopover?.appendChild(noneItem);

    let activeSecName = '(No section)';

    if (projectId && projectId !== 'inbox') {
      try {
        const res = await fetch(`/api/sections?project_id=${encodeURIComponent(projectId)}`);
        if (res.ok) {
          const rawSections = await res.json();
          const sections = Array.isArray(rawSections) ? rawSections : [];
          sections.forEach((sec) => {
            const opt = document.createElement('option');
            opt.value = sec.id;
            opt.textContent = sec.name;
            if (sec.id === selectedSectionId) {
              opt.selected = true;
              activeSecName = sec.name;
            }
            secSelect?.appendChild(opt);

            if (secPopover) {
              const item = document.createElement('div');
              item.className = `popover-item ${sec.id === selectedSectionId ? 'selected' : ''}`;
              item.dataset.value = sec.id;
              item.textContent = sec.name;
              item.addEventListener('click', () => {
                if (secSelect) {
                  secSelect.value = sec.id;
                  secSelect.dispatchEvent(new Event('change'));
                }
                this.syncSectionDisplay(sec.id, sec.name);
                secPopover.style.display = 'none';
              });
              secPopover.appendChild(item);
            }
          });
        }
      } catch (err) {
        console.error(err);
      }
    }
    this.syncSectionDisplay(selectedSectionId, activeSecName);
  }

  renderDetailSubtasks(parentTask) {
    const list = document.getElementById('detail-subtasks-list');
    list.innerHTML = '';

    const subtasks = parentTask.subtasks || [];
    let completedCount = 0;

    if (subtasks.length > 0) {
      subtasks.forEach((st) => {
        const isDone = !!st.completed;
        if (isDone) completedCount++;
        const row = document.createElement('div');
        row.className = 'task-row';
        row.style.cursor = 'pointer';
        row.innerHTML = `
          <div class="task-check ${isDone ? 'completed' : ''}">${Icons.check}</div>
          <div class="task-title" style="font-size:0.9rem; cursor:pointer; ${isDone ? 'text-decoration:line-through; opacity:0.6;' : ''}">${st.title}</div>
        `;
        row.querySelector('.task-check').addEventListener('click', async (e) => {
          e.stopPropagation();
          await fetch(`/api/tasks/${st.id}/complete`, { method: 'POST' });
          const refreshed = await this.fetchTask(parentTask.id);
          this.activeTaskDetail = refreshed;
          this.renderDetailSubtasks(refreshed);
          this.loadTasks();
        });
        let stTouchMoved = false;
        let stStartX = 0;
        let stStartY = 0;
        row.addEventListener('touchstart', (e) => {
          stStartX = e.touches[0].clientX;
          stStartY = e.touches[0].clientY;
          stTouchMoved = false;
        }, { passive: true });
        row.addEventListener('touchmove', (e) => {
          const dx = Math.abs(e.touches[0].clientX - stStartX);
          const dy = Math.abs(e.touches[0].clientY - stStartY);
          if (dx > 8 || dy > 8) stTouchMoved = true;
        }, { passive: true });
        row.addEventListener('touchend', (e) => {
          if (stTouchMoved) return;
          if (e.target.closest('.task-check')) return;
          e.preventDefault();
          this.openTaskDetailModal(st, parentTask);
        });
        row.addEventListener('click', (e) => {
          if (e.target.closest('.task-check')) return;
          this.openTaskDetailModal(st, parentTask);
        });
        list.appendChild(row);
      });
    }

    const countEl = document.getElementById('detail-subtasks-count');
    if (countEl) {
      countEl.textContent = `${completedCount}/${subtasks.length}`;
    }

    const addBox = document.getElementById('detail-add-subtask-box');
    if (!addBox) return;

    if (window.innerWidth <= 768) {
      addBox.innerHTML = `
        <button type="button" id="mobile-btn-add-subtask" class="btn-add-subtask-prompt" style="display:flex; align-items:center; gap:8px; width:100%; padding:10px 14px; background:transparent; border:1px dashed var(--rp-border); border-radius:10px; color:var(--rp-subtle); cursor:pointer; font-size:0.88rem; font-family:inherit;">
          <span style="font-size:1.15rem; line-height:1; color:var(--rp-love);">+</span>
          <span>Add subtask</span>
        </button>
      `;
      addBox.querySelector('#mobile-btn-add-subtask')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentTarget = this.activeTaskDetail || parentTask;
        this.openQuickAddModal({
          parentId: currentTarget.id,
          projectId: currentTarget.project_id || 'inbox',
          sectionId: currentTarget.section_id || null,
        });
      });
    } else {
      addBox.dataset.parentId = parentTask.id;
      addBox.dataset.projectId = parentTask.project_id || 'inbox';
      addBox.dataset.sectionId = parentTask.section_id || '';

      let input = addBox.querySelector('#detail-new-subtask-title');
      if (!input) {
        addBox.innerHTML = `
          <div style="display:flex; gap:6px;">
            <input type="text" id="detail-new-subtask-title" class="attr-input" placeholder="+ Add subtask..." />
            <button id="detail-btn-add-subtask" class="btn-primary" style="padding:4px 10px;">Add</button>
          </div>
        `;

        input = addBox.querySelector('#detail-new-subtask-title');
        input.addEventListener('focus', () => {
          this.isTitleEditing = false;
          this.isDescEditing = false;
          this.activeSubtaskInput = true;
        });
        input.addEventListener('blur', () => {
          this.activeSubtaskInput = false;
        });
        const submitSubtask = async () => {
          const val = input.value.trim();
          if (!val) return;
          const currentParentId = addBox.dataset.parentId || this.activeTaskDetail?.id;
          const currentProjectId = addBox.dataset.projectId || this.activeTaskDetail?.project_id || 'inbox';
          const currentSectionId = addBox.dataset.sectionId || this.activeTaskDetail?.section_id || null;
          if (!currentParentId) return;

          await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: val,
              parent_id: currentParentId,
              project_id: currentProjectId,
              section_id: currentSectionId,
            }),
          });
          input.value = '';
          const refreshed = await this.fetchTask(currentParentId);
          if (refreshed) {
            this.activeTaskDetail = refreshed;
            this.renderDetailSubtasks(refreshed);
          }
          this.loadTasks();
          this.focusDetailSubtaskInput();
        };

        addBox.querySelector('#detail-btn-add-subtask')?.addEventListener('click', submitSubtask);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submitSubtask();
          }
        });
      } else {
        input.value = '';
      }
    }
  }

  focusDetailSubtaskInput() {
    const input = document.getElementById('detail-new-subtask-title');
    if (input) {
      this.isTitleEditing = false;
      this.isDescEditing = false;
      this.activeSubtaskInput = true;
      input.focus();
      input.select?.();
    }
  }

  async fetchTask(id) {
    const res = await fetch(`/api/tasks/${id}`);
    if (res.ok) return await res.json();
    return null;
  }

  async saveActiveDetailTask() {
    if (!this.activeTaskDetail) return;
    const id = this.activeTaskDetail.id;

    let rec = document.getElementById('detail-recurrence-select')?.value;
    const mobRecSelect = document.getElementById('mobile-recurrence-select');
    if (window.innerWidth <= 768 && mobRecSelect && mobRecSelect.value !== undefined) {
      rec = mobRecSelect.value;
    }
    if (rec === 'custom') {
      const mobCron = document.getElementById('mobile-cron-input')?.value.trim();
      const deskCron = document.getElementById('detail-cron-input')?.value.trim();
      const customCron = (window.innerWidth <= 768 && mobCron !== undefined ? mobCron : deskCron) || '';
      rec = customCron ? (customCron.startsWith('cron:') ? customCron : 'cron:' + customCron) : null;
    } else if (!rec) {
      rec = null;
    }

    const deskLoc = document.getElementById('detail-location-input')?.value.trim();
    const mobLoc = document.getElementById('mobile-location-input')?.value.trim();
    const locVal = (window.innerWidth <= 768 && mobLoc !== undefined && mobLoc !== '') ? mobLoc : (deskLoc || mobLoc || null);

    const deskPri = document.getElementById('detail-priority-select')?.value;
    const mobPri = document.getElementById('mobile-priority-select')?.value;
    const priVal = parseInt((window.innerWidth <= 768 && mobPri ? mobPri : deskPri) || '3', 10);

    const titleEl = document.getElementById('detail-title');
    const finalTitle = titleEl ? titleEl.value.trim() : this.activeTaskDetail.title;
    const tokenChips = document.getElementById('detail-token-chips');
    if (tokenChips) {
      tokenChips.innerHTML = '';
      tokenChips.style.display = 'none';
    }

    const dueDate = document.getElementById('detail-due-date')?.value || null;

    const payload = {
      title: finalTitle,
      description: document.getElementById('detail-desc')?.value.trim(),
      project_id: document.getElementById('detail-project-select')?.value || this.activeTaskDetail.project_id || 'inbox',
      section_id: document.getElementById('detail-section-select')?.value || null,
      due_date: dueDate,
      priority: priVal,
      recurrence: rec,
      location: locVal || null,
    };

    await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    this.initialDetailTitle = finalTitle;
    this.initialDetailDesc = payload.description || '';
    if (this.detailModalInitialState) {
      this.detailModalInitialState.title = finalTitle;
      this.detailModalInitialState.description = payload.description || '';
    }
    await this.loadTasks();
  }

  getDetailModalCurrentState() {
    return {
      title: document.getElementById('detail-title')?.value.trim() || '',
      description: document.getElementById('detail-desc')?.value.trim() || '',
      projectId: document.getElementById('detail-project-select')?.value || 'inbox',
      sectionId: document.getElementById('detail-section-select')?.value || '',
      dueDate: document.getElementById('detail-due-date')?.value || '',
      priority: String(document.getElementById('detail-priority-select')?.value || '3'),
      recurrence: document.getElementById('detail-recurrence-select')?.value || '',
      cron: document.getElementById('detail-cron-input')?.value.trim() || '',
      location: document.getElementById('detail-location-input')?.value.trim() || '',
    };
  }

  hasActiveTextEditingDirty() {
    const active = document.activeElement;
    if (!active) return false;
    if (active.id === 'detail-title') {
      const curTitle = active.value.trim();
      const initTitle = (this.initialDetailTitle ?? (this.detailModalInitialState?.title || '')).trim();
      return curTitle !== initTitle;
    }
    if (active.id === 'detail-desc') {
      const curDesc = active.value.trim();
      const initDesc = (this.initialDetailDesc ?? (this.detailModalInitialState?.description || '')).trim();
      return curDesc !== initDesc;
    }
    return false;
  }

  hasDetailModalUnsavedChanges() {
    return this.hasActiveTextEditingDirty();
  }

  async handleDetailModalEscape() {
    if (this.hasActiveTextEditingDirty()) {
      const activeInput = document.activeElement;
      const isTitle = activeInput && activeInput.id === 'detail-title';
      const isDesc = activeInput && activeInput.id === 'detail-desc';
      const origVal = isTitle
        ? (this.initialDetailTitle ?? (this.detailModalInitialState?.title || ''))
        : (this.initialDetailDesc ?? (this.detailModalInitialState?.description || ''));

      const discard = await this.confirmModal(
        'Discard changes?',
        'Discard unsaved changes?',
        { okText: 'Discard', cancelText: 'Keep Editing' }
      );
      if (discard) {
        if (activeInput) {
          activeInput.value = origVal;
          if (isTitle) {
            const tokenChips = document.getElementById('detail-token-chips');
            if (tokenChips) {
              tokenChips.innerHTML = '';
              tokenChips.style.display = 'none';
            }
          }
          activeInput.blur();
        }
        this.isTitleEditing = false;
        this.isDescEditing = false;
        this.activeSubtaskInput = false;
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
        this.vim?.setMode('NORMAL');
        return;
      } else {
        if (activeInput) {
          activeInput.focus();
          const len = activeInput.value.length;
          activeInput.setSelectionRange?.(len, len);
        }
        if (isTitle) {
          this.isTitleEditing = true;
          this.isDescEditing = false;
          this.activeSubtaskInput = false;
        } else if (isDesc) {
          this.isTitleEditing = false;
          this.isDescEditing = true;
          this.activeSubtaskInput = false;
        }
        return;
      }
    } else {
      const activeInput = document.activeElement;
      const isTextInput = activeInput && ['INPUT', 'TEXTAREA'].includes(activeInput.tagName);
      if (isTextInput || this.isTitleEditing || this.isDescEditing || this.activeSubtaskInput) {
        if (activeInput && typeof activeInput.blur === 'function') {
          activeInput.blur();
        }
        this.isTitleEditing = false;
        this.isDescEditing = false;
        this.activeSubtaskInput = false;
        this.vim?.setMode('NORMAL');
        return;
      }

      await this.closeActiveTaskDetail(false);
    }
  }

  async navigateBackDetailTask() {
    await this.saveActiveDetailTask();
    this.detailModalInitialState = null;

    while (this.taskDetailHistory && this.taskDetailHistory.length > 0) {
      const prev = this.taskDetailHistory.pop();
      if (prev && (!this.activeTaskDetail || prev.id !== this.activeTaskDetail.id)) {
        const refreshed = await this.fetchTask(prev.id);
        if (refreshed) {
          await this.openTaskDetailModal(refreshed, null, true);
          return;
        }
      }
    }

    if (this.activeTaskDetail && this.activeTaskDetail.parent_id) {
      const parentTask = await this.fetchTask(this.activeTaskDetail.parent_id);
      if (parentTask) {
        await this.openTaskDetailModal(parentTask, null, true);
        return;
      }
    }

    await this.closeActiveTaskDetail(false);
  }

  async closeActiveTaskDetail(discard = false) {
    if (!discard) {
      await this.saveActiveDetailTask();
    }
    this.detailModalInitialState = null;
    this.isTitleEditing = false;
    this.isDescEditing = false;
    this.activeSubtaskInput = false;
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    this.activeTaskDetail = null;
    this.taskDetailHistory = [];
    this.closeAllModals();
    await this.loadTasks();
  }

  async completeActiveDetailTask() {
    if (!this.activeTaskDetail) return;
    const task = this.activeTaskDetail;
    const hasParent = !!task.parent_id;
    const hasHistory = this.taskDetailHistory && this.taskDetailHistory.length > 0;

    await this.completeTaskById(task.id);

    if (hasHistory || hasParent) {
      await this.navigateBackDetailTask();
    } else {
      this.closeAllModals();
    }
  }

  // ----------------------------------------------------------------------
  // Projects Management Modal
  // ----------------------------------------------------------------------

  openProjectModal() {
    const modal = document.getElementById('modal-project');
    const input = document.getElementById('modal-project-name');
    const parentSelect = document.getElementById('modal-project-parent');

    input.value = '';
    parentSelect.innerHTML = '<option value="">(Root)</option>';

    const addOpts = (projs, depth = 0) => {
      if (!Array.isArray(projs)) return;
      projs.forEach((p) => {
        if (!p || p.id === 'inbox') return;
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${'  '.repeat(depth)}# ${p.name}`;
        parentSelect.appendChild(opt);
        if (p.children && Array.isArray(p.children)) addOpts(p.children, depth + 1);
      });
    };
    addOpts(this.projects || []);

    modal?.classList.add('open');
    input?.focus();
  }

  async saveProjectModal() {
    const input = document.getElementById('modal-project-name');
    const parentSelect = document.getElementById('modal-project-parent');
    const name = input.value.trim();
    if (!name) return;

    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        parent_id: parentSelect.value || null,
      }),
    });
    if (res.ok) {
      const created = await res.json();
      this.closeAllModals();
      await this.loadProjects();
      this.switchView('project', created.id, created.name);
    }
  }

  isProjectDescendant(targetId, ancestorId) {
    if (targetId === ancestorId) return true;
    const anc = this.findProjectById(ancestorId);
    if (!anc) return false;
    const checkChildren = (node) => {
      if (!node.children) return false;
      for (const child of node.children) {
        if (child.id === targetId || checkChildren(child)) return true;
      }
      return false;
    };
    return checkChildren(anc);
  }

  findProjectById(id, list = this.projects) {
    if (!id) return null;
    if (id === 'inbox') return { id: 'inbox', name: 'Inbox' };
    for (const p of (list || [])) {
      if (p.id === id) return p;
      if (p.children) {
        const found = this.findProjectById(id, p.children);
        if (found) return found;
      }
    }
    return null;
  }

  getProjectSiblings(parentId) {
    const projs = Array.isArray(this.projects) ? this.projects : [];
    if (!parentId || parentId === 'inbox') {
      return [...projs.filter(p => (!p.parent_id || p.parent_id === '' || p.parent_id === 'inbox') && p.id !== 'inbox')];
    }
    const parent = this.findProjectById(parentId);
    return parent ? [...(parent.children || []).filter(p => p.id !== 'inbox')] : [];
  }

  async reorderProjectDrop(draggedId, targetProj, relX, relY, rowHeight, rowWidth) {
    if (!draggedId || !targetProj || draggedId === targetProj.id) return;
    if (draggedId === 'inbox' || targetProj.id === 'inbox') return;
    if (this.isProjectDescendant(targetProj.id, draggedId)) return;

    let newParentId = targetProj.parent_id || null;
    if (newParentId === 'inbox') newParentId = null;
    let isNest = false;

    // Moving right (relX >= 0.6 * rowWidth) -> NEST under targetProj as child
    if (rowWidth && relX >= 0.6 * rowWidth) {
      newParentId = targetProj.id;
      isNest = true;
    } else if (relX < 24 && targetProj.parent_id) {
      // Dragging far left on a nested project -> outdent to parent's level or root
      const parentOfTarget = this.findProjectById(targetProj.parent_id);
      newParentId = parentOfTarget && parentOfTarget.parent_id && parentOfTarget.parent_id !== 'inbox'
        ? parentOfTarget.parent_id
        : null;
    }

    const siblings = this.getProjectSiblings(newParentId).filter(p => p.id !== draggedId && p.id !== 'inbox');
    const draggedItem = this.findProjectById(draggedId);
    if (!draggedItem) return;

    if (isNest) {
      siblings.push(draggedItem);
    } else {
      const referenceProjId = (newParentId !== (targetProj.parent_id || null) && targetProj.parent_id)
        ? targetProj.parent_id
        : targetProj.id;
      const targetIdx = siblings.findIndex(p => p.id === referenceProjId);
      if (relY < rowHeight / 2) {
        if (targetIdx !== -1) siblings.splice(targetIdx, 0, draggedItem);
        else siblings.push(draggedItem);
      } else {
        if (targetIdx !== -1) siblings.splice(targetIdx + 1, 0, draggedItem);
        else siblings.push(draggedItem);
      }
    }

    const payload = siblings.map((p, idx) => ({
      id: p.id,
      parent_id: newParentId,
      position: idx * 10,
    }));

    await fetch('/api/projects/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await this.loadProjects();
  }

  renderProjectsTree() {
    const container = document.getElementById('projects-tree');
    if (!container) return;
    container.innerHTML = '';

    container.addEventListener('dragover', (e) => {
      if (this.draggedProjectId && this.draggedProjectId !== 'inbox') {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }
    });

    container.addEventListener('drop', async (e) => {
      if (!e.target.closest('.project-row') && this.draggedProjectId && this.draggedProjectId !== 'inbox') {
        e.preventDefault();
        const rootProjs = this.getProjectSiblings(null).filter(p => p.id !== this.draggedProjectId && p.id !== 'inbox');
        const draggedItem = this.findProjectById(this.draggedProjectId);
        if (!draggedItem) return;
        rootProjs.push(draggedItem);

        const payload = rootProjs.map((p, idx) => ({
          id: p.id,
          parent_id: null,
          position: idx * 10,
        }));

        await fetch('/api/projects/reorder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        await this.loadProjects();
      }
    });

    const renderLevel = (projects, parentEl, depth = 0) => {
      if (!Array.isArray(projects)) return;
      projects.forEach((p) => {
        if (!p || p.id === 'inbox') return;

        const item = document.createElement('div');
        item.className = 'project-tree-item';

        const row = document.createElement('div');
        row.className = 'project-row';
        row.dataset.id = p.id;
        row.draggable = true;
        if (this.currentView === 'project' && this.currentProjectId === p.id) {
          row.classList.add('active');
        }

        const status = this.getProjectDueStatus(p.id);
        const iconHtml = status === 'overdue'
          ? '<span class="project-status-dot overdue" title="Overdue tasks"></span>'
          : (status === 'today'
            ? '<span class="project-status-dot today" title="Tasks due today"></span>'
            : Icons.hash);

        row.innerHTML = `
          <span class="project-toggle">${iconHtml}</span>
          <span class="project-name">${p.name}</span>
          <div class="menu-trigger-wrapper project-actions">
            <button class="btn-icon-subtle btn-proj-more">${Icons.more}</button>
            <div class="popover-menu">
              <div class="popover-item proj-rename">${Icons.edit} <span>Rename</span></div>
              <div class="popover-item danger proj-del">${Icons.trash} <span>Delete</span></div>
            </div>
          </div>
        `;

        // Switch to project (instant mobile tap + desktop click)
        let touchMoved = false;
        let startX = 0;
        let startY = 0;
        row.addEventListener('touchstart', (e) => {
          startX = e.touches[0].clientX;
          startY = e.touches[0].clientY;
          touchMoved = false;
        }, { passive: true });

        row.addEventListener('touchmove', (e) => {
          const dx = Math.abs(e.touches[0].clientX - startX);
          const dy = Math.abs(e.touches[0].clientY - startY);
          if (dx > 8 || dy > 8) touchMoved = true;
        }, { passive: true });

        row.addEventListener('touchend', (e) => {
          if (touchMoved) return;
          if (this.draggedProjectId || this.draggedTaskId || this.draggedSectionId || this.dragJustEnded) return;
          if (e.target.closest('.btn-proj-more, .popover-menu')) return;
          e.preventDefault();
          this.switchView('project', p.id, p.name);
        });

        row.addEventListener('click', (e) => {
          if (this.draggedProjectId || this.draggedTaskId || this.draggedSectionId || this.dragJustEnded) return;
          if (e.target.closest('.btn-proj-more, .popover-menu')) return;
          this.switchView('project', p.id, p.name);
        });

        // 3-dots popover
        const moreBtn = row.querySelector('.btn-proj-more');
        const popover = row.querySelector('.popover-menu');
        const togglePopover = (e) => {
          e.stopPropagation();
          const willOpen = !popover.classList.contains('open');
          document.querySelectorAll('.popover-menu.open').forEach((p) => {
            p.classList.remove('open');
            p.closest('.project-row')?.classList.remove('menu-open');
            p.closest('.project-tree-item')?.classList.remove('menu-open');
          });
          if (willOpen) {
            popover.classList.add('open');
            row.classList.add('menu-open');
            item.classList.add('menu-open');
          }
        };

        let moreTouchTime = 0;
        moreBtn.addEventListener('touchend', (e) => {
          moreTouchTime = Date.now();
          e.stopPropagation();
          if (e.cancelable) e.preventDefault();
          togglePopover(e);
        });
        moreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (Date.now() - moreTouchTime < 400) return;
          togglePopover(e);
        });

        const handleRename = async (e) => {
          e.stopPropagation();
          if (e.cancelable) e.preventDefault();
          document.querySelectorAll('.popover-menu.open').forEach((p) => {
            p.classList.remove('open');
            p.closest('.project-row')?.classList.remove('menu-open');
            p.closest('.project-tree-item')?.classList.remove('menu-open');
          });
          const newName = await this.promptModal('Rename Project', p.name, 'Project name');
          if (newName && newName.trim()) {
            await fetch(`/api/projects/${p.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: newName.trim(), parent_id: p.parent_id, position: p.position }),
            });
            await this.loadProjects();
          }
        };
        const renameBtn = row.querySelector('.proj-rename');
        let renameTouchTime = 0;
        renameBtn?.addEventListener('touchend', (e) => {
          renameTouchTime = Date.now();
          e.stopPropagation();
          if (e.cancelable) e.preventDefault();
          handleRename(e);
        });
        renameBtn?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (Date.now() - renameTouchTime < 400) return;
          handleRename(e);
        });

        const handleDelete = async (e) => {
          e.stopPropagation();
          if (e.cancelable) e.preventDefault();
          document.querySelectorAll('.popover-menu.open').forEach((p) => {
            p.classList.remove('open');
            p.closest('.project-row')?.classList.remove('menu-open');
            p.closest('.project-tree-item')?.classList.remove('menu-open');
          });
          const confirmed = await this.confirmModal('Delete Project', `Delete "${p.name}" and all its tasks?`);
          if (confirmed) {
            await fetch(`/api/projects/${p.id}`, { method: 'DELETE' });
            await this.loadProjects();
            if (this.currentProjectId === p.id) this.switchView('upcoming');
          }
        };
        const delBtn = row.querySelector('.proj-del');
        let delTouchTime = 0;
        delBtn?.addEventListener('touchend', (e) => {
          delTouchTime = Date.now();
          e.stopPropagation();
          if (e.cancelable) e.preventDefault();
          handleDelete(e);
        });
        delBtn?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (Date.now() - delTouchTime < 400) return;
          handleDelete(e);
        });


        // --- TASK & SECTION DROP TARGET ON SIDEBAR PROJECT ---
        row.addEventListener('dragover', (e) => {
          if (this.draggedTaskId || this.draggedSectionId) {
            e.preventDefault();
            row.classList.add('task-drop-target');
            return;
          }

          // --- PROJECT DRAG-AND-DROP REORDER & NESTING ---
          if (this.draggedProjectId && this.draggedProjectId !== p.id) {
            if (this.isProjectDescendant(p.id, this.draggedProjectId)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = row.getBoundingClientRect();
            const relY = e.clientY - rect.top;
            const relX = e.clientX - rect.left;

            row.classList.remove('drag-top', 'drag-bottom', 'drag-nest');
            const isNest = relX >= 0.6 * rect.width;
            if (isNest) {
              row.classList.add('drag-nest');
            } else if (relY < rect.height / 2) {
              row.classList.add('drag-top');
            } else {
              row.classList.add('drag-bottom');
            }
          }
        });

        row.addEventListener('dragleave', (e) => {
          if (e.relatedTarget && row.contains(e.relatedTarget)) return;
          row.classList.remove('drag-top', 'drag-bottom', 'drag-nest', 'task-drop-target');
        });

        row.addEventListener('dragstart', (e) => {
          if (!this.draggedTaskId && !this.draggedSectionId) {
            this.draggedProjectId = p.id;
            row.classList.add('dragging');
            document.body.classList.add('is-dragging', 'dragging-project');
            e.dataTransfer.setData('project-id', p.id);
            e.dataTransfer.effectAllowed = 'move';
          }
        });

        row.addEventListener('dragend', () => {
          this.draggedProjectId = null;
          this.dragJustEnded = true;
          setTimeout(() => { this.dragJustEnded = false; }, 350);
          row.classList.remove('dragging');
          document.body.classList.remove('is-dragging', 'dragging-project');
          document.querySelectorAll('.project-row').forEach((el) => {
            el.classList.remove('drag-top', 'drag-bottom', 'drag-nest');
          });
        });

        row.addEventListener('drop', async (e) => {
          e.preventDefault();
          row.classList.remove('drag-top', 'drag-bottom', 'drag-nest', 'task-drop-target');

          // 1. Task dropped onto sidebar project
          if (this.draggedTaskId) {
            const tasksToMove = this.selectedTaskIds && this.selectedTaskIds.has(this.draggedTaskId)
              ? Array.from(this.selectedTaskIds)
              : [this.draggedTaskId];

            for (const tId of tasksToMove) {
              await fetch(`/api/tasks/${tId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project_id: p.id, section_id: null }),
              });
            }
            this.clearSelection();
            this.showToast(`✓ ${tasksToMove.length} task(s) moved to #${p.name}`);
            await this.loadTasks();
            return;
          }

          // 2. Section dropped onto sidebar project
          if (this.draggedSectionId) {
            await fetch(`/api/sections/${this.draggedSectionId}/move`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ project_id: p.id, position: 0 }),
            });
            this.showToast(`✓ Section moved to #${p.name}`);
            await this.loadSections(this.currentProjectId);
            await this.loadTasks();
            return;
          }

          // 3. Project dropped onto another project
          if (this.draggedProjectId && this.draggedProjectId !== p.id) {
            if (this.isProjectDescendant(p.id, this.draggedProjectId)) return;
            const rect = row.getBoundingClientRect();
            const relY = e.clientY - rect.top;
            const relX = e.clientX - rect.left;

            await this.reorderProjectDrop(this.draggedProjectId, p, relX, relY, rect.height, rect.width);
          }
        });

        item.appendChild(row);

        if (p.children && p.children.length > 0) {
          const childrenBox = document.createElement('div');
          childrenBox.className = 'project-children';
          renderLevel(p.children, childrenBox, depth + 1);
          item.appendChild(childrenBox);
        }

        parentEl.appendChild(item);
      });
    };

    renderLevel(this.projects || [], container);

    const tree = document.getElementById('projects-tree');
    if (tree) {
      tree.style.overflowY = tree.scrollHeight > tree.clientHeight ? 'auto' : 'hidden';
    }

    // Also attach task drop target to Inbox nav item
    const inboxNav = document.querySelector('.nav-item[data-view="inbox"]');
    if (inboxNav) {
      inboxNav.addEventListener('dragover', (e) => {
        if (this.draggedTaskId) {
          e.preventDefault();
          inboxNav.classList.add('task-drop-target');
        }
      });
      inboxNav.addEventListener('dragleave', () => inboxNav.classList.remove('task-drop-target'));
      inboxNav.addEventListener('drop', async (e) => {
        e.preventDefault();
        inboxNav.classList.remove('task-drop-target');
        if (this.draggedTaskId) {
          await fetch(`/api/tasks/${this.draggedTaskId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: 'inbox', section_id: null }),
          });
          this.showToast('✓ Moved to Inbox');
          await this.loadTasks();
        }
      });
    }
  }

  async confirmDeleteCurrentProject() {
    if (!this.currentProjectId) return;
    const confirmed = await this.confirmModal('Delete Project', 'Delete this project and all its tasks?');
    if (confirmed) {
      await fetch(`/api/projects/${this.currentProjectId}`, { method: 'DELETE' });
      await this.loadProjects();
      this.switchView('upcoming');
    }
  }

  getTargetProjectId() {
    if (this.currentView === 'project' && this.currentProjectId) {
      return this.currentProjectId;
    }
    return 'inbox';
  }

  async exportProjectCSV() {
    const targetId = this.getTargetProjectId();
    try {
      const res = await fetch(`/api/projects/export-csv?project_id=${encodeURIComponent(targetId)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Export failed' }));
        this.showToast(err.error || 'Error exporting CSV', 'error');
        return;
      }

      const blob = await res.blob();
      let filename = 'export.csv';
      const disposition = res.headers.get('Content-Disposition');
      if (disposition && disposition.includes('filename=')) {
        const match = disposition.match(/filename="?([^";]+)"?/);
        if (match && match[1]) {
          filename = match[1];
        }
      }

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      this.showToast(`✓ Exported CSV (${filename})`, 'success');
    } catch (err) {
      console.error('Export error:', err);
      this.showToast('Error exporting CSV', 'error');
    }
  }

  async importProjectCSV(file) {
    if (!file) return;
    const targetId = this.getTargetProjectId();
    const formData = new FormData();
    formData.append('file', file);

    try {
      this.showToast('Importing CSV...', 'info');
      const res = await fetch(`/api/projects/import-csv?project_id=${encodeURIComponent(targetId)}`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        this.showToast(data.error || 'Error importing CSV', 'error');
        return;
      }
      this.showToast(`✓ Import complete: ${data.tasks_count || 0} task(s) imported`, 'success');
      await this.loadProjects();
      await this.loadTasks();
    } catch (err) {
      console.error('Import error:', err);
      this.showToast('Error importing CSV file', 'error');
    }
  }

  // ----------------------------------------------------------------------
  // Move Section Modal
  // ----------------------------------------------------------------------

  openMoveSectionModal(section) {
    const modal = document.getElementById('modal-move-section');
    const select = document.getElementById('move-section-project-select');
    select.innerHTML = '';

    const addOpts = (projs, depth = 0) => {
      if (!Array.isArray(projs)) return;
      projs.forEach((p) => {
        if (!p || p.id === 'inbox') return;
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${'  '.repeat(depth)}# ${p.name}`;
        if (p.id !== this.currentProjectId) select.appendChild(opt);
        if (p.children && Array.isArray(p.children)) addOpts(p.children, depth + 1);
      });
    };
    addOpts(this.projects || []);

    const saveBtn = document.getElementById('modal-move-sec-save');
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);

    newSaveBtn.addEventListener('click', async () => {
      const targetProjId = select.value;
      if (!targetProjId) return;
      await fetch(`/api/sections/${section.id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: targetProjId, position: 0 }),
      });
      this.closeAllModals();
      await this.loadSections(this.currentProjectId);
      await this.loadTasks();
      this.showToast('✓ Section and its tasks moved');
    });

    modal.classList.add('open');
  }

  // ----------------------------------------------------------------------
  // ----------------------------------------------------------------------
  // Move Task Modal (Triggered by 'm')
  // ----------------------------------------------------------------------

  openMoveTaskModal() {
    const tasksToMove = this.selectedTaskIds.size > 0
      ? Array.from(this.selectedTaskIds)
      : (this.getSelectedTask() ? [this.getSelectedTask().id] : []);

    if (tasksToMove.length === 0) return;

    const modal = document.getElementById('modal-move-task');
    const input = document.getElementById('move-task-input');
    input.value = '';
    this.renderMoveTaskOptions('');

    modal.classList.add('open');
    input.focus();
  }

  renderMoveTaskOptions(query) {
    const list = document.getElementById('move-task-results');
    list.innerHTML = '';
    const q = query.toLowerCase().trim();

    // Flatten all projects
    const allProjs = [{ id: 'inbox', name: 'Inbox' }];
    const flatten = (projs) => {
      if (!Array.isArray(projs)) return;
      projs.forEach((p) => {
        if (!p) return;
        if (p.id !== 'inbox') allProjs.push(p);
        if (p.children && Array.isArray(p.children)) flatten(p.children);
      });
    };
    flatten(this.projects || []);

    const matches = allProjs.filter((p) => p.name.toLowerCase().includes(q));
    matches.forEach((p, idx) => {
      const item = document.createElement('div');
      item.className = `search-item ${idx === 0 ? 'selected' : ''}`;
      item.innerHTML = `
        <span class="search-item-title">${Icons.hash} <span>${p.name}</span></span>
        <span class="search-item-badge">Project</span>
      `;
      item.addEventListener('click', async () => {
        this.closeAllModals();
        const tasksToMove = this.selectedTaskIds.size > 0
          ? Array.from(this.selectedTaskIds)
          : (this.getSelectedTask() ? [this.getSelectedTask().id] : []);

        for (const taskId of tasksToMove) {
          await fetch(`/api/tasks/${taskId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: p.id, section_id: null }),
          });
        }
        const count = tasksToMove.length;
        this.clearSelection();
        this.showToast(`✓ ${count} task(s) moved to #${p.name}`);
        await this.loadTasks();
      });
      list.appendChild(item);
    });

    const input = document.getElementById('move-task-input');
    input.onkeydown = (e) => {
      const items = Array.from(list.querySelectorAll('.search-item'));
      if (items.length === 0) return;
      let curIdx = items.findIndex((el) => el.classList.contains('selected'));

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items.forEach((el) => el.classList.remove('selected'));
        const nextIdx = curIdx < items.length - 1 ? curIdx + 1 : 0;
        items[nextIdx].classList.add('selected');
        items[nextIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items.forEach((el) => el.classList.remove('selected'));
        const prevIdx = curIdx > 0 ? curIdx - 1 : items.length - 1;
        items[prevIdx].classList.add('selected');
        items[prevIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const selected = list.querySelector('.search-item.selected') || items[0];
        if (selected) selected.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeAllModals();
      }
    };
  }

  // ----------------------------------------------------------------------
  // Move Task to Section Modal (Triggered by 's')
  // ----------------------------------------------------------------------

  openMoveTaskToSectionModal() {
    const tasksToMove = this.selectedTaskIds.size > 0
      ? Array.from(this.selectedTaskIds)
      : (this.getSelectedTask() ? [this.getSelectedTask().id] : []);

    if (tasksToMove.length === 0) return;

    const modal = document.getElementById('modal-move-task-sec');
    const input = document.getElementById('move-task-sec-input');
    if (!modal || !input) return;

    input.value = '';
    this.renderMoveTaskToSectionOptions('');

    modal.classList.add('open');
    setTimeout(() => input.focus(), 30);
  }

  renderMoveTaskToSectionOptions(query) {
    const list = document.getElementById('move-task-sec-results');
    if (!list) return;
    list.innerHTML = '';
    const q = query.toLowerCase().trim();

    let allSecs = [];

    if (this.currentView === 'upcoming') {
      const today = new Date();
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      for (let i = 0; i < 7; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        const iso = d.toISOString().slice(0, 10);
        let name = `${dayNames[d.getDay()]} ${d.getDate()} ${monthNames[d.getMonth()]}`;
        if (i === 0) name = `Today (${name})`;
        else if (i === 1) name = `Tomorrow (${name})`;
        allSecs.push({
          id: iso,
          name,
          isDate: true,
          iso,
        });
      }
    } else {
      allSecs.push({
        id: null,
        name: 'No section (Root)',
        isRoot: true,
      });
      (this.sections || []).forEach((sec) => {
        allSecs.push({
          id: sec.id,
          name: sec.name,
          isSection: true,
        });
      });
    }

    const matches = allSecs.filter((s) => s.name.toLowerCase().includes(q));

    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'search-item';
      empty.style.color = 'var(--rp-muted)';
      empty.style.cursor = 'default';
      empty.textContent = 'No matching sections';
      list.appendChild(empty);
      return;
    }

    matches.forEach((s, idx) => {
      const item = document.createElement('div');
      item.className = `search-item ${idx === 0 ? 'selected' : ''}`;
      item.innerHTML = `
        <span class="search-item-title">${s.isDate ? Icons.calendar : Icons.folder} <span>${s.name}</span></span>
        <span class="search-item-badge">${s.isDate ? 'Day' : 'Section'}</span>
      `;

      item.addEventListener('click', async () => {
        this.closeAllModals();
        const tasksToMove = this.selectedTaskIds.size > 0
          ? Array.from(this.selectedTaskIds)
          : (this.getSelectedTask() ? [this.getSelectedTask().id] : []);

        for (const taskId of tasksToMove) {
          const patch = {};
          if (s.isDate) {
            patch.due_date = s.iso;
          } else {
            patch.section_id = s.id;
          }
          await fetch(`/api/tasks/${taskId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          });
        }
        const count = tasksToMove.length;
        this.clearSelection();
        this.showToast(`✓ ${count} task(s) moved to "${s.name}"`);
        await this.loadTasks();
      });

      list.appendChild(item);
    });

    const input = document.getElementById('move-task-sec-input');
    input.onkeydown = (e) => {
      const items = Array.from(list.querySelectorAll('.search-item')).filter(
        (el) => !el.style.cursor || el.style.cursor !== 'default'
      );
      if (items.length === 0) return;
      let curIdx = items.findIndex((el) => el.classList.contains('selected'));

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items.forEach((el) => el.classList.remove('selected'));
        const nextIdx = curIdx < items.length - 1 ? curIdx + 1 : 0;
        items[nextIdx].classList.add('selected');
        items[nextIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items.forEach((el) => el.classList.remove('selected'));
        const prevIdx = curIdx > 0 ? curIdx - 1 : items.length - 1;
        items[prevIdx].classList.add('selected');
        items[prevIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const selected = list.querySelector('.search-item.selected') || items[0];
        if (selected) selected.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeAllModals();
      }
    };
  }

  // ----------------------------------------------------------------------
  // Global Search Modal (Ripgrep / Command Palette)
  // ----------------------------------------------------------------------

  openGlobalSearch() {
    const modal = document.getElementById('modal-search');
    const input = document.getElementById('global-search-input');
    input.value = '';
    document.getElementById('global-search-results').innerHTML = '';
    modal.classList.add('open');
    input.focus();
  }

  async performGlobalSearch(query) {
    const resultsContainer = document.getElementById('global-search-results');
    resultsContainer.innerHTML = '';
    const q = query.toLowerCase().trim();
    if (!q) return;

    // 1. Matching Projects
    const allProjs = [{ id: 'inbox', name: 'Inbox' }];
    const flatten = (projs) => {
      if (!Array.isArray(projs)) return;
      projs.forEach((p) => {
        if (!p) return;
        if (p.id !== 'inbox') allProjs.push(p);
        if (p.children && Array.isArray(p.children)) flatten(p.children);
      });
    };
    flatten(this.projects || []);

    let isFirst = true;
    allProjs.filter((p) => p.name.toLowerCase().includes(q)).forEach((p) => {
      const item = document.createElement('div');
      item.className = `search-item ${isFirst ? 'selected' : ''}`;
      isFirst = false;
      item.innerHTML = `
        <span class="search-item-title">${Icons.hash} <strong>${p.name}</strong></span>
        <span class="search-item-badge">Project</span>
      `;
      item.addEventListener('click', () => {
        this.closeAllModals();
        if (p.id === 'inbox') this.switchView('inbox');
        else this.switchView('project', p.id, p.name);
      });
      resultsContainer.appendChild(item);
    });

    // 2. Matching Tasks from API
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const tasks = await res.json();
        tasks.forEach((t) => {
          const item = document.createElement('div');
          item.className = `search-item ${isFirst ? 'selected' : ''}`;
          isFirst = false;
          const pName = t.project_name || 'Inbox';
          item.innerHTML = `
            <span class="search-item-title">${Icons.check} <span>${t.title}</span></span>
            <span class="search-item-badge"># ${pName}</span>
          `;
          item.addEventListener('click', async () => {
            this.closeAllModals();
            const projId = t.project_id || 'inbox';
            if (projId === 'inbox') {
              await this.switchView('inbox');
            } else {
              await this.switchView('project', projId, t.project_name);
            }
            this.openTaskDetailModal(t);
          });
          resultsContainer.appendChild(item);
        });
      }
    } catch (err) {
      console.error(err);
    }

    const input = document.getElementById('global-search-input');
    input.onkeydown = (e) => {
      const items = Array.from(resultsContainer.querySelectorAll('.search-item'));
      if (items.length === 0) return;
      let curIdx = items.findIndex((el) => el.classList.contains('selected'));

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items.forEach((el) => el.classList.remove('selected'));
        const nextIdx = curIdx < items.length - 1 ? curIdx + 1 : 0;
        items[nextIdx].classList.add('selected');
        items[nextIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items.forEach((el) => el.classList.remove('selected'));
        const prevIdx = curIdx > 0 ? curIdx - 1 : items.length - 1;
        items[prevIdx].classList.add('selected');
        items[prevIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const selected = resultsContainer.querySelector('.search-item.selected') || items[0];
        if (selected) selected.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeAllModals();
      }
    };
  }

  // ----------------------------------------------------------------------
  // Vim Actions & Task Navigation
  // ----------------------------------------------------------------------

  focusSidebar() {
    this.focusArea = 'sidebar';
    const items = this.getAllSidebarNavElements();
    const activeIdx = items.findIndex((el) => el.classList.contains('active'));
    this.sidebarIndex = activeIdx !== -1 ? activeIdx : 0;
    this.updateFocusVisuals();
    this.vim.updateStatus();
  }

  focusTasks(resetToFirst = true) {
    this.focusArea = 'tasks';
    if (resetToFirst && this.flattenedTasks.length > 0) {
      this.selectedIndex = 0;
    }
    this.updateFocusVisuals();
    this.updateSelectedRow();
    this.vim.updateStatus();
    this.updateStatusPosition();
  }

  updateFocusVisuals() {
    const sidebar = document.querySelector('.sidebar');
    if (this.focusArea === 'sidebar') {
      sidebar?.classList.add('keyboard-focused');
      this.updateSidebarSelection();
    } else {
      sidebar?.classList.remove('keyboard-focused');
      document.querySelectorAll('.project-row.keyboard-selected, .nav-item.keyboard-selected').forEach((el) => {
        el.classList.remove('keyboard-selected');
      });
    }
  }

  getAllSidebarNavElements() {
    const navItems = Array.from(document.querySelectorAll('.nav-item'));
    const projRows = Array.from(document.querySelectorAll('.project-row'));
    return [...navItems, ...projRows];
  }

  updateSidebarSelection() {
    const items = this.getAllSidebarNavElements();
    items.forEach((el) => el.classList.remove('keyboard-selected'));
    if (items[this.sidebarIndex]) {
      items[this.sidebarIndex].classList.add('keyboard-selected');
      items[this.sidebarIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  previewSelectedSidebarItem() {
    const items = this.getAllSidebarNavElements();
    const item = items[this.sidebarIndex];
    if (!item) return;

    if (item.classList.contains('nav-item')) {
      const view = item.dataset.view;
      this.switchView(view, null, '', true);
    } else if (item.classList.contains('project-row')) {
      const projId = item.dataset.id;
      const proj = this.findProjectById(projId);
      this.switchView('project', projId, proj?.name || '', true);
    }
  }

  selectNextSidebarItem() {
    const items = this.getAllSidebarNavElements();
    if (this.sidebarIndex < items.length - 1) {
      this.sidebarIndex++;
      this.updateSidebarSelection();
      this.previewSelectedSidebarItem();
    }
  }

  selectPrevSidebarItem() {
    if (this.sidebarIndex > 0) {
      this.sidebarIndex--;
      this.updateSidebarSelection();
      this.previewSelectedSidebarItem();
    }
  }

  activateSelectedSidebarItem() {
    const items = this.getAllSidebarNavElements();
    const item = items[this.sidebarIndex];
    if (item) {
      if (item.classList.contains('nav-item')) {
        const view = item.dataset.view;
        this.switchView(view, null, '', false);
      } else if (item.classList.contains('project-row')) {
        const projId = item.dataset.id;
        const proj = this.findProjectById(projId);
        this.switchView('project', projId, proj?.name || '', false);
      }
    }
    this.focusTasks(true);
  }

  getSelectedSidebarProject() {
    const items = this.getAllSidebarNavElements();
    const item = items[this.sidebarIndex];
    if (!item || !item.classList.contains('project-row')) return null;
    const projId = item.dataset.id;
    return this.findProjectById(projId);
  }

  async moveSelectedSidebarProjectDown() {
    const proj = this.getSelectedSidebarProject();
    if (!proj || proj.id === 'inbox') return;

    const parentId = (proj.parent_id && proj.parent_id !== 'inbox') ? proj.parent_id : null;
    const siblings = this.getProjectSiblings(parentId);
    const idx = siblings.findIndex((p) => p.id === proj.id);
    if (idx === -1 || idx >= siblings.length - 1) return;

    const temp = siblings[idx];
    siblings[idx] = siblings[idx + 1];
    siblings[idx + 1] = temp;

    const payload = siblings.map((p, i) => ({
      id: p.id,
      parent_id: parentId,
      position: i * 10,
    }));

    await fetch('/api/projects/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await this.loadProjects();

    const newItems = this.getAllSidebarNavElements();
    const newIdx = newItems.findIndex((el) => el.classList.contains('project-row') && el.dataset.id === proj.id);
    if (newIdx !== -1) {
      this.sidebarIndex = newIdx;
      this.updateSidebarSelection();
    }
  }

  async moveSelectedSidebarProjectUp() {
    const proj = this.getSelectedSidebarProject();
    if (!proj || proj.id === 'inbox') return;

    const parentId = (proj.parent_id && proj.parent_id !== 'inbox') ? proj.parent_id : null;
    const siblings = this.getProjectSiblings(parentId);
    const idx = siblings.findIndex((p) => p.id === proj.id);
    if (idx <= 0) return;

    const temp = siblings[idx];
    siblings[idx] = siblings[idx - 1];
    siblings[idx - 1] = temp;

    const payload = siblings.map((p, i) => ({
      id: p.id,
      parent_id: parentId,
      position: i * 10,
    }));

    await fetch('/api/projects/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await this.loadProjects();

    const newItems = this.getAllSidebarNavElements();
    const newIdx = newItems.findIndex((el) => el.classList.contains('project-row') && el.dataset.id === proj.id);
    if (newIdx !== -1) {
      this.sidebarIndex = newIdx;
      this.updateSidebarSelection();
    }
  }

  async indentSelectedSidebarProject() {
    const proj = this.getSelectedSidebarProject();
    if (!proj || proj.id === 'inbox') return;

    const parentId = (proj.parent_id && proj.parent_id !== 'inbox') ? proj.parent_id : null;
    const siblings = this.getProjectSiblings(parentId);
    const idx = siblings.findIndex((p) => p.id === proj.id);
    if (idx <= 0) return;

    const prevSibling = siblings[idx - 1];
    if (!prevSibling || prevSibling.id === 'inbox') return;
    if (this.isProjectDescendant(prevSibling.id, proj.id)) return;

    const newSiblings = this.getProjectSiblings(prevSibling.id).filter((p) => p.id !== proj.id && p.id !== 'inbox');
    newSiblings.push(proj);

    const payload = newSiblings.map((p, i) => ({
      id: p.id,
      parent_id: prevSibling.id,
      position: i * 10,
    }));

    await fetch('/api/projects/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await this.loadProjects();

    const newItems = this.getAllSidebarNavElements();
    const newIdx = newItems.findIndex((el) => el.classList.contains('project-row') && el.dataset.id === proj.id);
    if (newIdx !== -1) {
      this.sidebarIndex = newIdx;
      this.updateSidebarSelection();
    }
    this.showToast(`✓ Indented "${proj.name}"`);
  }

  async outdentSelectedSidebarProject() {
    const proj = this.getSelectedSidebarProject();
    if (!proj || proj.id === 'inbox' || !proj.parent_id || proj.parent_id === 'inbox') return;

    const currentParent = this.findProjectById(proj.parent_id);
    const newParentId = currentParent && currentParent.parent_id && currentParent.parent_id !== 'inbox'
      ? currentParent.parent_id
      : null;

    const grandSiblings = this.getProjectSiblings(newParentId).filter((p) => p.id !== proj.id && p.id !== 'inbox');
    const parentIdx = grandSiblings.findIndex((p) => p.id === proj.parent_id);
    if (parentIdx !== -1) {
      grandSiblings.splice(parentIdx + 1, 0, proj);
    } else {
      grandSiblings.push(proj);
    }

    const payload = grandSiblings.map((p, i) => ({
      id: p.id,
      parent_id: newParentId,
      position: i * 10,
    }));

    await fetch('/api/projects/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await this.loadProjects();

    const newItems = this.getAllSidebarNavElements();
    const newIdx = newItems.findIndex((el) => el.classList.contains('project-row') && el.dataset.id === proj.id);
    if (newIdx !== -1) {
      this.sidebarIndex = newIdx;
      this.updateSidebarSelection();
    }
    this.showToast(`✓ Outdented "${proj.name}"`);
  }

  updateSelectedRow() {
    document.querySelectorAll('.task-row').forEach((row) => row.classList.remove('selected'));
    if (this.selectedIndex >= 0 && this.selectedIndex < this.flattenedTasks.length) {
      const activeTask = this.flattenedTasks[this.selectedIndex];
      const row = document.querySelector(`.task-row[data-id="${activeTask.id}"]`);
      if (row) {
        row.classList.add('selected');
        const isInputActive = document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
        if (!this.isModalOpen() && !isInputActive) {
          const container = row.closest('.main-content') || document.querySelector('.main-content');
          if (container) {
            if (this.selectedIndex === 0) {
              container.scrollTop = 0;
            } else {
              const cRect = container.getBoundingClientRect();
              const rRect = row.getBoundingClientRect();
              const paddingBottom = 70;
              const paddingTop = 70;

              if (rRect.bottom > cRect.bottom - paddingBottom) {
                container.scrollTop += (rRect.bottom - (cRect.bottom - paddingBottom));
              } else if (rRect.top < cRect.top + paddingTop) {
                container.scrollTop -= ((cRect.top + paddingTop) - rRect.top);
              }
            }
          } else {
            row.scrollIntoView({ block: 'nearest', behavior: 'auto' });
          }
        }
      }
    }
  }

  updateStatusPosition() {
    const posEl = document.getElementById('status-position');
    if (posEl) {
      if (this.flattenedTasks.length === 0) {
        posEl.textContent = '0 / 0';
      } else {
        posEl.textContent = `${this.selectedIndex + 1} / ${this.flattenedTasks.length}`;
      }
    }
  }

  selectNextTask() {
    if (this.flattenedTasks.length === 0) return;
    if (this.selectedIndex < this.flattenedTasks.length - 1) {
      this.selectedIndex++;
      this.updateSelectedRow();
      this.updateStatusPosition();
    }
  }

  selectPrevTask() {
    if (this.flattenedTasks.length === 0) return;
    if (this.selectedIndex > 0) {
      this.selectedIndex--;
      this.updateSelectedRow();
      this.updateStatusPosition();
    }
  }

  selectFirstTask() {
    if (this.flattenedTasks.length === 0) return;
    this.selectedIndex = 0;
    this.updateSelectedRow();
    this.updateStatusPosition();
  }

  selectLastTask() {
    if (this.flattenedTasks.length === 0) return;
    this.selectedIndex = this.flattenedTasks.length - 1;
    this.updateSelectedRow();
    this.updateStatusPosition();
  }

  getSelectedTask() {
    if (this.selectedIndex >= 0 && this.selectedIndex < this.flattenedTasks.length) {
      return this.flattenedTasks[this.selectedIndex];
    }
    return null;
  }

  editSelectedTask() {
    const task = this.getSelectedTask();
    if (task) this.openTaskDetailModal(task);
  }

  removeTaskFromParentTree(taskId) {
    const removeRecursive = (list) => {
      const idx = list.findIndex((t) => t.id === taskId);
      if (idx !== -1) {
        return list.splice(idx, 1)[0];
      }
      for (const t of list) {
        if (t.subtasks && t.subtasks.length > 0) {
          const found = removeRecursive(t.subtasks);
          if (found) return found;
        }
      }
      return null;
    };
    return removeRecursive(this.tasks);
  }

  getTaskParent(taskId) {
    const task = this.findTaskById(taskId);
    if (!task || !task.parent_id) return null;
    return this.findTaskById(task.parent_id);
  }

  async saveTasksOrder(targetTaskIdToSelect = null) {
    const items = [];
    const flatten = (list) => {
      if (!Array.isArray(list)) return;
      list.forEach((t) => {
        items.push({
          id: t.id,
          position: items.length * 10,
          parent_id: t.parent_id || null,
          section_id: t.section_id || null,
          project_id: t.project_id || null,
        });
        if (t.subtasks && t.subtasks.length > 0) {
          flatten(t.subtasks);
        }
      });
    };
    flatten(this.tasks || []);

    await fetch('/api/tasks/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(items),
    });

    const selectedId = targetTaskIdToSelect || (this.getSelectedTask() ? this.getSelectedTask().id : null);
    await this.loadTasks();

    if (selectedId) {
      const newIdx = this.flattenedTasks.findIndex((t) => t.id === selectedId);
      if (newIdx !== -1) {
        this.selectedIndex = newIdx;
        this.updateSelectedRow();
        this.updateStatusPosition();
      }
    }
  }

  async moveSelectedTaskDown() {
    const task = this.getSelectedTask();
    if (!task) return;

    if (task.parent_id) {
      const parent = this.getTaskParent(task.id);
      if (!parent || !parent.subtasks) return;
      const idx = parent.subtasks.findIndex((t) => t.id === task.id);
      if (idx === -1 || idx >= parent.subtasks.length - 1) return;

      const temp = parent.subtasks[idx];
      parent.subtasks[idx] = parent.subtasks[idx + 1];
      parent.subtasks[idx + 1] = temp;
      await this.saveTasksOrder(task.id);
    } else {
      const sameGroupRoots = this.tasks.filter((t) => {
        if (this.currentView === 'project') {
          return (t.section_id || null) === (task.section_id || null);
        }
        if (this.currentView === 'upcoming') {
          const d1 = t.due_date ? t.due_date.slice(0, 10) : null;
          const d2 = task.due_date ? task.due_date.slice(0, 10) : null;
          return d1 === d2;
        }
        return true;
      });

      const idx = sameGroupRoots.findIndex((t) => t.id === task.id);
      if (idx === -1 || idx >= sameGroupRoots.length - 1) return;

      const nextSibling = sameGroupRoots[idx + 1];
      const posTask = this.tasks.findIndex((t) => t.id === task.id);
      const posNext = this.tasks.findIndex((t) => t.id === nextSibling.id);
      if (posTask === -1 || posNext === -1) return;

      const [removed] = this.tasks.splice(posTask, 1);
      const newPos = this.tasks.findIndex((t) => t.id === nextSibling.id);
      this.tasks.splice(newPos + 1, 0, removed);

      await this.saveTasksOrder(task.id);
    }
  }

  async moveSelectedTaskUp() {
    const task = this.getSelectedTask();
    if (!task) return;

    if (task.parent_id) {
      const parent = this.getTaskParent(task.id);
      if (!parent || !parent.subtasks) return;
      const idx = parent.subtasks.findIndex((t) => t.id === task.id);
      if (idx <= 0) return;

      const temp = parent.subtasks[idx];
      parent.subtasks[idx] = parent.subtasks[idx - 1];
      parent.subtasks[idx - 1] = temp;
      await this.saveTasksOrder(task.id);
    } else {
      const sameGroupRoots = this.tasks.filter((t) => {
        if (this.currentView === 'project') {
          return (t.section_id || null) === (task.section_id || null);
        }
        if (this.currentView === 'upcoming') {
          const d1 = t.due_date ? t.due_date.slice(0, 10) : null;
          const d2 = task.due_date ? task.due_date.slice(0, 10) : null;
          return d1 === d2;
        }
        return true;
      });

      const idx = sameGroupRoots.findIndex((t) => t.id === task.id);
      if (idx <= 0) return;

      const prevSibling = sameGroupRoots[idx - 1];
      const posTask = this.tasks.findIndex((t) => t.id === task.id);
      const posPrev = this.tasks.findIndex((t) => t.id === prevSibling.id);
      if (posTask === -1 || posPrev === -1) return;

      const [removed] = this.tasks.splice(posTask, 1);
      const newPos = this.tasks.findIndex((t) => t.id === prevSibling.id);
      this.tasks.splice(newPos, 0, removed);

      await this.saveTasksOrder(task.id);
    }
  }

  async indentSelectedTask() {
    const task = this.getSelectedTask();
    if (!task) return;

    let targetParent = null;

    if (task.parent_id) {
      const parent = this.getTaskParent(task.id);
      if (!parent || !parent.subtasks) return;
      const idx = parent.subtasks.findIndex((t) => t.id === task.id);
      if (idx <= 0) return;
      targetParent = parent.subtasks[idx - 1];
    } else {
      const sameGroupRoots = this.tasks.filter((t) => {
        if (t.parent_id) return false;
        if (this.currentView === 'project') {
          return (t.section_id || null) === (task.section_id || null) && t.project_id === task.project_id;
        } else if (this.currentView === 'upcoming') {
          const d1 = t.due_date ? t.due_date.slice(0, 10) : null;
          const d2 = task.due_date ? task.due_date.slice(0, 10) : null;
          return d1 === d2;
        }
        return t.project_id === 'inbox' || t.project_id === task.project_id;
      });

      const idx = sameGroupRoots.findIndex((t) => t.id === task.id);
      if (idx <= 0) return;
      targetParent = sameGroupRoots[idx - 1];
    }

    if (!targetParent || targetParent.id === task.id) return;
    if (this.isTaskDescendant(targetParent.id, task.id)) return;

    const removed = this.removeTaskFromParentTree(task.id);
    if (!removed) return;

    removed.parent_id = targetParent.id;
    removed.project_id = targetParent.project_id;
    removed.section_id = targetParent.section_id || null;
    if (targetParent.due_date) removed.due_date = targetParent.due_date;

    if (!targetParent.subtasks) targetParent.subtasks = [];
    targetParent.subtasks.push(removed);

    await this.saveTasksOrder(removed.id);
  }

  async outdentSelectedTask() {
    const task = this.getSelectedTask();
    if (!task || !task.parent_id) return;

    const currentParent = this.getTaskParent(task.id);
    if (!currentParent) return;

    const removed = this.removeTaskFromParentTree(task.id);
    if (!removed) return;

    const newParentId = currentParent.parent_id || null;
    removed.parent_id = newParentId;
    removed.project_id = currentParent.project_id;
    removed.section_id = currentParent.section_id || null;

    if (newParentId) {
      const grandParent = this.getTaskParent(currentParent.id);
      if (grandParent && grandParent.subtasks) {
        const pIdx = grandParent.subtasks.findIndex((t) => t.id === currentParent.id);
        if (pIdx !== -1) grandParent.subtasks.splice(pIdx + 1, 0, removed);
        else grandParent.subtasks.push(removed);
      }
    } else {
      const pIdx = this.tasks.findIndex((t) => t.id === currentParent.id);
      if (pIdx !== -1) this.tasks.splice(pIdx + 1, 0, removed);
      else this.tasks.push(removed);
    }

    await this.saveTasksOrder(removed.id);
  }

  async setSelectedTaskPriority(priority) {
    if (![1, 2, 3].includes(priority)) return;
    const tasksToUpdate = this.selectedTaskIds.size > 0
      ? Array.from(this.selectedTaskIds)
      : (this.getSelectedTask() ? [this.getSelectedTask().id] : []);

    if (tasksToUpdate.length === 0) return;

    for (const taskId of tasksToUpdate) {
      await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority }),
      });
    }

    const pLabels = { 1: 'P1 (Urgent)', 2: 'P2 (High)', 3: 'P3 (Normal)' };
    this.showToast(`✓ Priority set to ${pLabels[priority] || 'P' + priority}`);
    await this.loadTasks();
  }

  toggleSelectTask() {
    const task = this.getSelectedTask();
    if (!task) return;

    if (this.selectedTaskIds.has(task.id)) {
      this.selectedTaskIds.delete(task.id);
    } else {
      this.selectedTaskIds.add(task.id);
    }

    this.updateTaskSelectionVisuals();

    // Advance cursor down like Yazi / Ranger
    if (this.selectedIndex < this.flattenedTasks.length - 1) {
      this.selectedIndex++;
      this.updateSelectedRow();
      this.updateStatusPosition();
    }
  }

  updateTaskSelectionVisuals() {
    document.querySelectorAll('.task-row').forEach((row) => {
      const id = row.dataset.id;
      if (this.selectedTaskIds.has(id)) {
        row.classList.add('yazi-selected');
      } else {
        row.classList.remove('yazi-selected');
      }
    });

    const count = this.selectedTaskIds.size;
    const modeEl = document.getElementById('vim-mode');
    if (modeEl && count > 0 && this.focusArea === 'tasks') {
      modeEl.textContent = `-- VISUAL (${count}) --`;
    } else if (modeEl && count === 0) {
      this.vim.updateStatus();
    }
  }

  clearSelection() {
    this.selectedTaskIds.clear();
    this.updateTaskSelectionVisuals();
    this.vim.updateStatus();
  }

  findTaskById(id, list = this.tasks) {
    for (const t of list) {
      if (t.id === id) return t;
      if (t.subtasks && t.subtasks.length > 0) {
        const found = this.findTaskById(id, t.subtasks);
        if (found) return found;
      }
    }
    return null;
  }

  isTaskDescendant(targetId, ancestorId) {
    if (targetId === ancestorId) return true;
    const anc = this.findTaskById(ancestorId);
    if (!anc) return false;
    const checkSubtasks = (node) => {
      if (!node.subtasks) return false;
      for (const st of node.subtasks) {
        if (st.id === targetId || checkSubtasks(st)) return true;
      }
      return false;
    };
    return checkSubtasks(anc);
  }

  pushUndoAction(action) {
    if (!this.undoStack) this.undoStack = [];
    this.undoStack.push(action);
    if (this.undoStack.length > 50) {
      this.undoStack.shift();
    }
  }

  async undoLastAction() {
    if (!this.undoStack || this.undoStack.length === 0) {
      this.showToast('Nothing to undo', 'info');
      return;
    }

    const action = this.undoStack.pop();
    if (action.type === 'delete_tasks' && action.items && action.items.length > 0) {
      const tasksToRestore = [];
      const updatesToRestore = [];

      for (const item of action.items) {
        if (item.deleted && item.snapshot) {
          tasksToRestore.push(item.snapshot);
        } else if (!item.deleted) {
          updatesToRestore.push({
            id: item.id,
            due_date: item.previousDueDate,
          });
        }
      }

      try {
        const res = await fetch('/api/tasks/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tasks: tasksToRestore,
            updates: updatesToRestore,
          }),
        });

        if (res.ok) {
          await this.loadTasks();

          // Move cursor to first restored task
          if (tasksToRestore.length > 0) {
            const restoredId = tasksToRestore[0].id;
            const newIdx = this.flattenedTasks.findIndex((t) => t.id === restoredId);
            if (newIdx !== -1) {
              this.selectedIndex = newIdx;
              this.updateSelectedRow();
              this.updateStatusPosition();
            }
          }

          const count = action.items.length;
          const firstTitle = action.items[0]?.snapshot?.title || '';
          if (count === 1 && firstTitle) {
            this.showToast(`✓ Restored task "${firstTitle}"`, 'success');
          } else {
            this.showToast(`✓ Restored ${count} task(s)`, 'success');
          }
        } else {
          const errData = await res.json().catch(() => ({ error: 'Error' }));
          this.showToast(errData.error || 'Error restoring task', 'error');
        }
      } catch (err) {
        console.error('Undo error:', err);
        this.showToast('Error during undo', 'error');
      }
    }
  }

  async completeSelectedTask() {
    const scroller = document.querySelector('.main-content');
    if (scroller) this.preservedScrollTop = scroller.scrollTop;

    const tasksToComplete = this.selectedTaskIds.size > 0
      ? Array.from(this.selectedTaskIds)
      : (this.getSelectedTask() ? [this.getSelectedTask().id] : []);

    if (tasksToComplete.length === 0) return;

    const actionItems = [];
    for (const taskId of tasksToComplete) {
      const item = await this.completeTaskById(taskId, false, false);
      if (item) actionItems.push(item);
    }
    if (actionItems.length > 0) {
      this.pushUndoAction({
        type: 'delete_tasks',
        items: actionItems,
      });
      this.showToast(`✓ ${actionItems.length} task(s) completed`, 'info', {
        text: 'Undo',
        onClick: () => this.undoLastAction(),
      });
    }
    this.clearSelection();
    await this.loadTasks();
  }

  async completeTaskById(id, reload = true, pushUndo = true) {
    if (this.preservedScrollTop === undefined) {
      const scroller = document.querySelector('.main-content');
      if (scroller) this.preservedScrollTop = scroller.scrollTop;
    }
    const originalTask = this.findTaskById(id);
    const snapshot = originalTask ? JSON.parse(JSON.stringify(originalTask)) : null;

    try {
      const res = await fetch(`/api/tasks/${id}/complete`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        const item = {
          id,
          snapshot: snapshot || data.task,
          deleted: data.deleted,
          previousDueDate: snapshot?.due_date || data.previous_due_date || null,
        };
        if (pushUndo) {
          this.pushUndoAction({
            type: 'delete_tasks',
            items: [item],
          });
          if (data.deleted) {
            this.showToast('✓ Task completed', 'info', {
              text: 'Undo',
              onClick: () => this.undoLastAction(),
            });
          } else {
            this.showToast(`↻ Next date: ${data.task.due_date}`, 'info', {
              text: 'Undo',
              onClick: () => this.undoLastAction(),
            });
          }
        }
        if (reload) await this.loadTasks();
        return item;
      }
    } catch (err) {
      console.error(err);
    }
    return null;
  }

  async submitQuickAddModal() {
    const titleInput = document.getElementById('quick-add-title');
    const descInput = document.getElementById('quick-add-desc');
    const text = titleInput ? titleInput.value.trim() : '';
    if (!text) return;

    const desc = descInput ? descInput.value.trim() : '';
    this.closeAllModals();

    const parseRes = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const parsed = parseRes.ok ? await parseRes.json() : {};

    const payload = {
      title: parsed.title || text,
      description: desc,
      project_id: parsed.project_id || 'inbox',
      priority: parsed.priority || 3,
      due_date: parsed.due_date || null,
      recurrence: parsed.recurrence || null,
      location: parsed.location || null,
    };

    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    this.showToast('✓ Task added');
    await this.loadTasks();
  }

  openQuickAddBelow() {
    const task = this.getSelectedTask();
    if (task) {
      const row = document.querySelector(`.task-row[data-id="${task.id}"]`);
      if (row) {
        const secBlock = row.closest('.section-block') || row.closest('.upcoming-day-group') || row.parentElement;
        const taskList = row.closest('.task-list') || row.parentElement;
        this.openInlineComposer(secBlock, taskList, {
          projectId: task.project_id,
          sectionId: task.section_id,
          dueDate: null,
          insertAfterEl: row,
          afterTaskId: task.id,
        });
        return;
      }
    }
    const triggers = document.querySelectorAll('.btn-add-task-trigger');
    if (triggers.length > 0) triggers[0].click();
  }

  openQuickAddAbove() {
    this.openQuickAddBelow();
  }

  openQuickAddModal(customDefaults = {}) {
    const modal = document.getElementById('modal-quick-add');
    const container = document.getElementById('modal-quick-add-container');
    if (!modal || !container) return;

    container.innerHTML = '';
    modal.classList.add('open');
    document.body.classList.add('modal-open');

    if (window.visualViewport) {
      const offset = window.innerHeight - (window.visualViewport.height + window.visualViewport.offsetTop);
      modal.style.bottom = `${Math.max(0, offset)}px`;
    }

    let defaults = {
      projectId: this.currentView === 'project' && this.currentProjectId ? this.currentProjectId : 'inbox',
      priority: 3,
    };
    if (this.currentView === 'upcoming') {
      defaults.dueDate = new Date().toISOString().slice(0, 10);
    }
    defaults = { ...defaults, ...customDefaults };

    const composer = this.createComposerElement({
      defaults,
      onCancel: () => {
        this.closeQuickAddModal();
      },
      onSubmitted: async (createdTask, closed) => {
        if (defaults.parentId) {
          const refreshed = await this.fetchTask(defaults.parentId);
          if (refreshed) {
            this.activeTaskDetail = refreshed;
            this.renderDetailSubtasks(refreshed);
          }
          this.loadTasks();
        }
        if (closed) {
          this.closeQuickAddModal();
        }
      },
    });

    container.appendChild(composer);
    const titleInput = composer.querySelector('.composer-title');
    if (titleInput) {
      titleInput.focus();
      this.vim.setMode('INSERT');
    }
  }


  openQuickAddInbox() {
    this.openQuickAddModal({ projectId: 'inbox' });
  }

  toggleHelpModal() {
    document.getElementById('modal-help')?.classList.toggle('open');
  }

  isModalOpen() {
    return document.querySelector('.modal-overlay.open') !== null;
  }

  // ----------------------------------------------------------------------
  // Authentication & Security (Master Password)
  // ----------------------------------------------------------------------

  async checkAuthStatus() {
    try {
      const res = await fetch('/api/auth/status');
      if (!res.ok) return true;
      const data = await res.json();
      this.hasPassword = !!data.has_password;
      this.isAuthenticated = !!data.authenticated;

      if (!this.hasPassword) {
        this.openAuthSetupModal();
        return false;
      } else if (!this.isAuthenticated) {
        this.openAuthLoginModal();
        return false;
      }
      return true;
    } catch (err) {
      console.error('Failed to check auth status:', err);
      return true;
    }
  }

  openAuthSetupModal() {
    this.closeAllModals();
    const modal = document.getElementById('modal-auth-setup');
    if (modal) modal.classList.add('open');
    const pwdInput = document.getElementById('auth-setup-password');
    if (pwdInput) {
      pwdInput.value = '';
      document.getElementById('auth-setup-confirm').value = '';
      document.getElementById('auth-setup-error').style.display = 'none';
      setTimeout(() => pwdInput.focus(), 80);
    }
  }

  openAuthLoginModal() {
    this.closeAllModals();
    const modal = document.getElementById('modal-auth-login');
    if (modal) modal.classList.add('open');
    const pwdInput = document.getElementById('auth-login-password');
    if (pwdInput) {
      pwdInput.value = '';
      document.getElementById('auth-login-error').style.display = 'none';
      setTimeout(() => pwdInput.focus(), 80);
    }
  }

  openChangePasswordModal() {
    const modal = document.getElementById('modal-change-password');
    if (modal) modal.classList.add('open');
    const curInput = document.getElementById('change-pwd-current');
    if (curInput) {
      curInput.value = '';
      document.getElementById('change-pwd-new').value = '';
      document.getElementById('change-pwd-confirm').value = '';
      document.getElementById('change-pwd-error').style.display = 'none';
      setTimeout(() => curInput.focus(), 80);
    }
  }

  async handleAuthSetupSubmit(e) {
    e.preventDefault();
    const pwd = document.getElementById('auth-setup-password').value;
    const confirm = document.getElementById('auth-setup-confirm').value;
    const errEl = document.getElementById('auth-setup-error');

    if (!pwd || pwd.length < 4) {
      errEl.textContent = 'Password must be at least 4 characters long';
      errEl.style.display = 'block';
      return;
    }
    if (pwd !== confirm) {
      errEl.textContent = 'Passwords do not match';
      errEl.style.display = 'block';
      return;
    }

    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        errEl.textContent = data.error || 'Failed to setup password';
        errEl.style.display = 'block';
        return;
      }
      this.isAuthenticated = true;
      this.hasPassword = true;
      document.getElementById('modal-auth-setup')?.classList.remove('open');
      await this.loadProjects();
      this.switchView('inbox');
    } catch (err) {
      errEl.textContent = 'Network or server error';
      errEl.style.display = 'block';
    }
  }

  async handleAuthLoginSubmit(e) {
    e.preventDefault();
    const pwd = document.getElementById('auth-login-password').value;
    const errEl = document.getElementById('auth-login-error');

    if (!pwd) {
      errEl.textContent = 'Password is required';
      errEl.style.display = 'block';
      return;
    }

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        errEl.textContent = data.error || 'Invalid password';
        errEl.style.display = 'block';
        return;
      }
      this.isAuthenticated = true;
      document.getElementById('modal-auth-login')?.classList.remove('open');
      await this.loadProjects();
      this.switchView(this.currentView || 'upcoming');
    } catch (err) {
      errEl.textContent = 'Network or server error';
      errEl.style.display = 'block';
    }
  }

  async handleChangePasswordSubmit(e) {
    e.preventDefault();
    const oldPwd = document.getElementById('change-pwd-current').value;
    const newPwd = document.getElementById('change-pwd-new').value;
    const confirm = document.getElementById('change-pwd-confirm').value;
    const errEl = document.getElementById('change-pwd-error');

    if (!newPwd || newPwd.length < 4) {
      errEl.textContent = 'New password must be at least 4 characters long';
      errEl.style.display = 'block';
      return;
    }
    if (newPwd !== confirm) {
      errEl.textContent = 'New passwords do not match';
      errEl.style.display = 'block';
      return;
    }

    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_password: oldPwd, new_password: newPwd }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        errEl.textContent = data.error || 'Failed to update password';
        errEl.style.display = 'block';
        return;
      }
      document.getElementById('modal-change-password')?.classList.remove('open');
    } catch (err) {
      errEl.textContent = 'Network or server error';
      errEl.style.display = 'block';
    }
  }

  async handleAuthLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (_) {}
    this.isAuthenticated = false;
    this.openAuthLoginModal();
  }

  closeQuickAddModal() {
    const quickModal = document.getElementById('modal-quick-add');
    if (quickModal) {
      quickModal.classList.remove('open');
      quickModal.style.bottom = '';
    }
    const container = document.getElementById('modal-quick-add-container');
    if (container) container.innerHTML = '';

    const detailModal = document.getElementById('modal-task-detail');
    const isDetailOpen = detailModal && detailModal.classList.contains('open');

    if (isDetailOpen && this.activeTaskDetail) {
      document.body.classList.add('modal-open');
      this.fetchTask(this.activeTaskDetail.id).then((refreshed) => {
        if (refreshed) {
          this.activeTaskDetail = refreshed;
          this.renderDetailSubtasks(refreshed);
        }
      });
    } else {
      if (!this.isModalOpen()) {
        document.body.classList.remove('modal-open');
      }
      this.vim.setMode('NORMAL');
    }
  }

  closeAllModals() {
    document.querySelectorAll('.modal-overlay').forEach((m) => {
      if ((m.id === 'modal-auth-setup' || m.id === 'modal-auth-login') && !this.isAuthenticated) {
        return;
      }
      m.classList.remove('open');
    });
    document.body.classList.remove('modal-open');
    document.querySelectorAll('.inline-section-creator').forEach((el) => el.remove());
    document.querySelectorAll('.popover-menu.open').forEach((p) => {
      p.classList.remove('open');
      p.closest('.project-row')?.classList.remove('menu-open');
      p.closest('.project-tree-item')?.classList.remove('menu-open');
    });
    const quickAddContainer = document.getElementById('modal-quick-add-container');
    const quickModal = document.getElementById('modal-quick-add');
    if (quickModal) quickModal.style.bottom = '';

    const detailModal = document.querySelector('#modal-task-detail .detail-modal');
    if (detailModal) {
      detailModal.style.transform = '';
      detailModal.style.transition = '';
    }
    const detailOverlay = document.getElementById('modal-task-detail');
    if (detailOverlay) {
      detailOverlay.style.backgroundColor = '';
      detailOverlay.style.transition = '';
    }
    const detailDatePopover = document.getElementById('detail-due-date-popover');
    if (detailDatePopover) {
      detailDatePopover.style.display = 'none';
      detailDatePopover.classList.remove('pop-above');
    }
    const mobDatePopover = document.getElementById('mobile-due-date-popover');
    if (mobDatePopover) mobDatePopover.style.display = 'none';
    const sheetPri = document.getElementById('sheet-priority');
    if (sheetPri) sheetPri.style.display = 'none';
    const sheetLoc = document.getElementById('sheet-location');
    if (sheetLoc) sheetLoc.style.display = 'none';
    this.hideMobileBackdrop();
    this.isTitleEditing = false;
    this.isDescEditing = false;
    this.activeSubtaskInput = false;
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    this.taskDetailHistory = [];
    this.activeTaskDetail = null;
    this.vim.setMode('NORMAL');
  }

  showMobileBackdrop(onDismiss = null) {
    const backdrop = document.getElementById('mobile-sheet-backdrop');
    if (!backdrop) return;
    this.mobileBackdropDismissCallback = onDismiss;
    backdrop.style.display = 'block';
    backdrop.classList.add('active');
  }

  hideMobileBackdrop() {
    const backdrop = document.getElementById('mobile-sheet-backdrop');
    if (!backdrop) return;
    backdrop.classList.remove('active');
    backdrop.style.display = 'none';
    this.mobileBackdropDismissCallback = null;
  }

  openMobileDateSheet(initialDate, callback = null) {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    const sheetPri = document.getElementById('sheet-priority');
    if (sheetPri) sheetPri.style.display = 'none';
    const sheetLoc = document.getElementById('sheet-location');
    if (sheetLoc) sheetLoc.style.display = 'none';

    const sheet = document.getElementById('mobile-due-date-popover');
    const picker = document.getElementById('mobile-due-date-picker');
    this.activeDateSheetCallback = callback;
    if (picker) {
      picker.value = initialDate ? initialDate.slice(0, 10) : '';
    }
    if (sheet) sheet.style.display = 'block';
    this.showMobileBackdrop(() => this.closeMobileDateSheet());
  }

  closeMobileDateSheet() {
    const picker = document.getElementById('mobile-due-date-picker');
    if (picker) picker.blur();
    const sheet = document.getElementById('mobile-due-date-popover');
    if (sheet) sheet.style.display = 'none';
    this.hideMobileBackdrop();
    this.activeDateSheetCallback = null;
  }

  openMobilePrioritySheet(currentP, callback = null) {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    const sheetDate = document.getElementById('mobile-due-date-popover');
    if (sheetDate) sheetDate.style.display = 'none';
    const sheetLoc = document.getElementById('sheet-location');
    if (sheetLoc) sheetLoc.style.display = 'none';

    const sheet = document.getElementById('sheet-priority');
    this.activePrioritySheetCallback = callback;
    const p = parseInt(currentP, 10) || 3;
    if (sheet) {
      sheet.querySelectorAll('.sheet-priority-item').forEach((item) => {
        const itemP = parseInt(item.dataset.priority, 10) || 3;
        item.classList.toggle('selected', itemP === p);
      });
      sheet.style.display = 'block';
    }
    this.showMobileBackdrop(() => this.closeMobilePrioritySheet());
  }

  closeMobilePrioritySheet() {
    const sheet = document.getElementById('sheet-priority');
    if (sheet) sheet.style.display = 'none';
    this.hideMobileBackdrop();
    this.activePrioritySheetCallback = null;
  }

  openMobileLocationSheet(currentLoc, callback = null) {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    const sheetDate = document.getElementById('mobile-due-date-popover');
    if (sheetDate) sheetDate.style.display = 'none';
    const sheetPri = document.getElementById('sheet-priority');
    if (sheetPri) sheetPri.style.display = 'none';

    const sheet = document.getElementById('sheet-location');
    const input = document.getElementById('sheet-location-input');
    this.activeLocationSheetCallback = callback;
    if (input) {
      input.value = currentLoc || '';
    }
    if (sheet) sheet.style.display = 'block';
    this.showMobileBackdrop(() => this.closeMobileLocationSheet());
    if (input) {
      requestAnimationFrame(() => input.focus());
    }
  }

  closeMobileLocationSheet() {
    const sheet = document.getElementById('sheet-location');
    if (sheet) sheet.style.display = 'none';
    this.hideMobileBackdrop();
    this.activeLocationSheetCallback = null;
  }

  async submitComposerTask(composerEl) {
    if (!composerEl) {
      composerEl = document.querySelector('.inline-composer, #modal-quick-add-container .inline-composer');
    }
    if (!composerEl) return;

    const titleInput = composerEl.querySelector('.composer-title');
    const rawTitle = titleInput ? titleInput.value.trim() : '';
    if (!rawTitle) {
      titleInput?.focus();
      return;
    }

    const descInput = composerEl.querySelector('.composer-desc');
    const description = descInput ? descInput.value.trim() : '';

    let cleanTitle = rawTitle;
    let dueDate = composerEl.dataset.dueDate || null;
    let recurrence = composerEl.dataset.recurrence || null;
    let location = composerEl.dataset.location || null;
    let parsed = null;

    try {
      parsed = parseQuickTokens(rawTitle, new Date(), composerEl._ignoredTokens);
      if (parsed) {
        cleanTitle = parsed.cleanTitle || parsed.title || rawTitle;
        if (parsed.dueDate && !composerEl.dataset.dueDate) dueDate = parsed.dueDate;
        if (parsed.recurrence && !composerEl.dataset.recurrence) recurrence = parsed.recurrence;
        if (parsed.location && !composerEl.dataset.location) location = parsed.location;
      }
    } catch (err) {
      console.error("Token parse error:", err);
    }

    let priority;
    if (parsed && parsed.priority && !composerEl._ignoredTokens?.has('priority') && !composerEl._priorityManual) {
      priority = parsed.priority;
    } else if (composerEl._priorityManual && composerEl.dataset.priority) {
      priority = parseInt(composerEl.dataset.priority, 10);
    } else if (parsed && parsed.priority && !composerEl._ignoredTokens?.has('priority')) {
      priority = parsed.priority;
    } else {
      priority = parseInt(composerEl.dataset.priority, 10) || 3;
    }

    const payload = {
      title: cleanTitle,
      description: description,
      project_id: composerEl.dataset.projectId || this.currentProjectId || 'inbox',
      section_id: composerEl.dataset.sectionId || null,
      priority: priority,
      due_date: dueDate,
      recurrence: recurrence,
      location: location,
    };
    if (composerEl.dataset.parentId) payload.parent_id = composerEl.dataset.parentId;

    let createdTask = null;
    try {
      const createRes = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (createRes.status === 200 || createRes.status === 201 || createRes.ok) {
        createdTask = await createRes.json();
      }
    } catch (err) {
      console.error('Failed to create task', err);
    }

    if (createdTask) {
      titleInput.value = '';
      if (descInput) descInput.value = '';
      delete composerEl.dataset.priority;
      composerEl._priorityManual = false;
      delete composerEl.dataset.dueDate;
      delete composerEl.dataset.recurrence;
      delete composerEl.dataset.location;
      if (composerEl._ignoredTokens) composerEl._ignoredTokens.clear();

      const previewChips = composerEl.querySelector('.composer-chips-preview');
      if (previewChips) previewChips.innerHTML = '';

      const chipDateVal = composerEl.querySelector('.chip-date .val');
      const chipDateBtn = composerEl.querySelector('.chip-date');
      if (chipDateVal) chipDateVal.textContent = 'Due date';
      if (chipDateBtn) chipDateBtn.classList.remove('has-value');

      const chipPriorityVal = composerEl.querySelector('.chip-priority .val');
      const chipPriorityBtn = composerEl.querySelector('.chip-priority');
      if (chipPriorityVal) chipPriorityVal.textContent = 'Priority';
      if (chipPriorityBtn) chipPriorityBtn.className = 'composer-chip chip-priority';

      const chipLocVal = composerEl.querySelector('.chip-location .val');
      const chipLocBtn = composerEl.querySelector('.chip-location');
      if (chipLocVal) chipLocVal.textContent = 'Location';
      if (chipLocBtn) chipLocBtn.classList.remove('has-value');

      const locInput = composerEl.querySelector('.popover-loc-input');
      if (locInput) locInput.value = '';

      const isQuickAddModal = composerEl.closest('#modal-quick-add');

      await this.loadTasks();

      if (isQuickAddModal) {
        this.closeQuickAddModal();
      } else {
        if (!document.body.contains(composerEl)) {
          let reinserted = false;
          if (payload.section_id) {
            const secBlock = document.querySelector(`.section-block[data-section-id="${payload.section_id}"]`);
            if (secBlock) {
              const secList = secBlock.querySelector('.task-list');
              if (secList) {
                secList.after(composerEl);
                reinserted = true;
              }
            }
          }
          if (!reinserted) {
            const list = document.querySelector('.task-list');
            if (list) list.after(composerEl);
            else document.getElementById('tasks-area')?.appendChild(composerEl);
          }
        }
        titleInput.focus();
        this.vim.setMode('INSERT');
        requestAnimationFrame(() => {
          titleInput.focus();
          this.vim.setMode('INSERT');
        });
      }

      if (composerEl._onSubmitted) {
        await composerEl._onSubmitted(createdTask, !!isQuickAddModal);
      }
    }

    return createdTask;
  }

  handleQuickAddSubmit(composerEl) {
    return this.submitComposerTask(composerEl);
  }

  showToast(message, type = '', action = null) {
    if (!type && !message.includes('Import') && !message.includes('Export') && !action) {
      return;
    }
    let toast = document.getElementById('app-notification-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'app-notification-toast';
      document.body.appendChild(toast);
    }

    if (type === 'error') {
      toast.style.borderColor = 'var(--rp-love)';
      toast.style.color = 'var(--rp-love)';
    } else if (type === 'success') {
      toast.style.borderColor = 'var(--rp-foam)';
      toast.style.color = 'var(--rp-foam)';
    } else {
      toast.style.borderColor = 'var(--rp-border)';
      toast.style.color = 'var(--rp-text)';
    }

    toast.innerHTML = '';
    const textSpan = document.createElement('span');
    textSpan.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    textSpan.textContent = message;
    toast.appendChild(textSpan);

    if (action && action.text && action.onClick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-undo-btn';
      btn.textContent = action.text;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toast.classList.remove('open');
        action.onClick();
      });
      toast.appendChild(btn);
    }

    toast.classList.add('open');
    clearTimeout(this._toastTimeout);
    this._toastTimeout = setTimeout(() => {
      toast.classList.remove('open');
    }, action ? 5000 : 3500);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new GetDoneApp();
});
