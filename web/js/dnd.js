// Drag and drop for tasks, sections and projects, with the mouse or by
// long-pressing on touch screens. Draggable elements carry data-drag
// ("task" | "section" | "project") and data-id; the app decides what a drop
// position means (see App.dropTarget / App.drop).

const MOUSE_THRESHOLD = 5; // px before a mouse press becomes a drag
const LONG_PRESS = 300;    // ms before a touch becomes a drag
const TOUCH_SLOP = 8;      // px a finger may move during the long press
const EDGE = 60;           // px from the edge of a scroll area that triggers auto-scroll

const IGNORE = 'button, a, input, textarea, select, .task-check';

export function initDragAndDrop(app) {
  let pending = null; // { el, x, y, timer }
  let drag = null;    // { kind, id, source, ghost, offsetX, offsetY, target }
  let suppressClickUntil = 0;

  const start = (el, x, y) => {
    const rect = el.getBoundingClientRect();
    const ghost = el.cloneNode(true);
    ghost.classList.add('drag-ghost');
    Object.assign(ghost.style, { width: `${rect.width}px`, left: `${rect.left}px`, top: `${rect.top}px` });
    document.body.append(ghost);
    el.classList.add('dragging');
    document.body.classList.add('is-dragging');
    drag = { kind: el.dataset.drag, id: el.dataset.id, source: el, ghost, offsetX: x - rect.left, offsetY: y - rect.top, target: null };
    app.closeTransientUi();
  };

  const move = (x, y) => {
    drag.ghost.style.left = `${x - drag.offsetX}px`;
    drag.ghost.style.top = `${y - drag.offsetY}px`;
    autoScroll(x, y);
    const under = document.elementFromPoint(x, y);
    const target = under ? app.dropTarget(drag.kind, drag.id, under, x, y) : null;
    if (drag.target?.el !== target?.el || drag.target?.place !== target?.place) {
      drag.target?.el.classList.remove('drop-before', 'drop-after', 'drop-inside', 'drop-into');
      target?.el.classList.add(`drop-${target.place}`);
    }
    drag.target = target;
  };

  const finish = (commit) => {
    if (drag) {
      const { kind, id, target, source, ghost } = drag;
      target?.el.classList.remove('drop-before', 'drop-after', 'drop-inside', 'drop-into');
      source.classList.remove('dragging');
      ghost.remove();
      document.body.classList.remove('is-dragging');
      drag = null;
      suppressClickUntil = Date.now() + 350;
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
