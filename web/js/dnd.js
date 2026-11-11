// Drag and drop for tasks, sections and projects, with the mouse or by
// long-pressing on touch screens. Draggable elements carry data-drag
// ("task" | "section" | "project") and data-id; the app decides what a drop
// position means (see App.dropTarget / App.drop). A target is either an
// element to highlight (a project in the sidebar, a day) or a line drawn in
// a gap between rows: one indicator, with a dot, indented to the depth the
// item will have.

const MOUSE_THRESHOLD = 5; // px before a mouse press becomes a drag
const LONG_PRESS = 300;    // ms before a touch becomes a drag
const TOUCH_SLOP = 8;      // px a finger may move during the long press
const EDGE = 60;           // px from the edge of a scroll area that triggers auto-scroll

const IGNORE = 'button, a, input, textarea, select, .task-check';

export function initDragAndDrop(app) {
  let pending = null; // { el, x, y, timer }
  let drag = null;    // { kind, id, source, hidden, ghost, startX, offsetX, target, x, y }
  let suppressClickUntil = 0;
  const line = document.createElement('div');
  line.className = 'drop-line';
  line.hidden = true;
  document.body.append(line);

  const start = (el, x, y) => {
    const rect = el.getBoundingClientRect();
    const ghost = el.cloneNode(true);
    ghost.classList.remove('cursor', 'selected', 'active');
    ghost.classList.add('drag-ghost');
    Object.assign(ghost.style, { width: `${Math.min(rect.width, 420)}px`, left: `${rect.left}px`, top: `${rect.top}px` });
    document.body.append(ghost);
    // Tasks and projects leave their list while dragged (the line shows where
    // they will land); sections stay, faded.
    const hidden = app.dragStart(el.dataset.drag, el);
    (hidden || el).classList.add(hidden ? 'drag-hidden' : 'dragging');
    document.body.classList.add('is-dragging');
    drag = {
      kind: el.dataset.drag, id: el.dataset.id, source: el, hidden, ghost,
      startX: x, offsetX: Math.min(x - rect.left, 40), target: null,
    };
    app.closeTransientUi();
  };

  const move = (x, y) => {
    drag.x = x;
    drag.y = y;
    // The ghost floats just under the pointer, so the line stays in sight.
    drag.ghost.style.left = `${x - drag.offsetX}px`;
    drag.ghost.style.top = `${y + 14}px`;
    autoScroll(x, y);
    locate();
  };

  // Finds the target under the pointer; also run when the page scrolls.
  const locate = () => {
    const { x, y } = drag;
    const under = document.elementFromPoint(x, y);
    // How far the item was pulled right (or left) since the drag started.
    const pull = x - drag.startX;
    const target = under ? app.dropTarget(drag.kind, drag.id, under, x, y, pull, drag.target) : null;
    const oldEl = drag.target?.line ? null : drag.target?.el;
    const newEl = target?.line ? null : target?.el;
    if (oldEl !== newEl || drag.target?.place !== target?.place) {
      oldEl?.classList.remove('drop-before', 'drop-after', 'drop-into');
      newEl?.classList.add(`drop-${target.place}`);
    }
    showLine(target?.line);
    drag.target = target;
  };

  const showLine = (pos) => {
    line.hidden = !pos;
    if (pos) Object.assign(line.style, { left: `${pos.left}px`, top: `${pos.top}px`, width: `${pos.width}px` });
  };

  const finish = (commit) => {
    if (drag) {
      const { kind, id, target, source, hidden, ghost } = drag;
      hidden?.classList.remove('drag-hidden');
      target?.el?.classList.remove('drop-before', 'drop-after', 'drop-into');
      showLine(null);
      source.classList.remove('dragging');
      ghost.remove();
      document.body.classList.remove('is-dragging');
      drag = null;
      suppressClickUntil = Date.now() + 350;
      app.dragEnded();
      if (commit && target) app.drop(kind, id, target);
    }
    if (pending) clearTimeout(pending.timer);
    pending = null;
  };

  // Mouse
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest(IGNORE)) return;
    const el = e.target.closest('[data-drag]');
    if (!el || !app.canDrag(el.dataset.drag)) return;
    pending = { el, x: e.clientX, y: e.clientY };
  });
  document.addEventListener('mousemove', (e) => {
    if (drag) {
      e.preventDefault();
      move(e.clientX, e.clientY);
    } else if (pending && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > MOUSE_THRESHOLD) {
      start(pending.el, pending.x, pending.y);
      pending = null;
      move(e.clientX, e.clientY);
    }
  });
  document.addEventListener('mouseup', () => finish(true));
  window.addEventListener('blur', () => finish(false));
  document.addEventListener('keydown', (e) => {
    if (drag && e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  }, true);

  // Touch: long press, then drag. Scrolling stays native until the drag starts.
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || e.target.closest(IGNORE)) return;
    const el = e.target.closest('[data-drag]');
    if (!el || !app.canDrag(el.dataset.drag)) return;
    const t = e.touches[0];
    pending = {
      el, x: t.clientX, y: t.clientY,
      timer: setTimeout(() => {
        if (!pending) return;
        navigator.vibrate?.(20);
        start(pending.el, pending.x, pending.y);
        move(pending.x, pending.y);
        pending = null;
      }, LONG_PRESS),
    };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (drag) {
      if (e.cancelable) e.preventDefault(); // no scrolling while dragging
      move(t.clientX, t.clientY);
    } else if (pending && Math.hypot(t.clientX - pending.x, t.clientY - pending.y) > TOUCH_SLOP) {
      clearTimeout(pending.timer);
      pending = null;
    }
  }, { passive: false });
  document.addEventListener('touchend', (e) => {
    if (drag && e.cancelable) e.preventDefault(); // no click after a drop
    finish(true);
  }, { passive: false });
  document.addEventListener('touchcancel', () => finish(false));
  document.addEventListener('contextmenu', (e) => {
    if (drag || pending) e.preventDefault(); // long press must not open the menu
  });

  // Auto-scroll (or a wheel) moves the rows under a still pointer.
  document.addEventListener('scroll', () => drag && locate(), true);

  // A drag ends with a click on the element under the pointer: swallow it.
  document.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  function autoScroll(x, y) {
    const area = document.elementFromPoint(x, y)?.closest('.main, .project-tree');
    if (!area) return;
    const rect = area.getBoundingClientRect();
    if (y < rect.top + EDGE) area.scrollTop -= Math.ceil((rect.top + EDGE - y) / 4);
    else if (y > rect.bottom - EDGE) area.scrollTop += Math.ceil((y - rect.bottom + EDGE) / 4);
  }
}
