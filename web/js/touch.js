// Touch Drag & Drop Adapter for Mobile (iOS Safari & Android)
// Enables native-like drag and drop reordering via touch events.

export function initTouchDrag(app) {
  let timer = null;
  let isDragging = false;
  let touchStart = null;
  let draggedEl = null;
  let ghostEl = null;
  let currentDropTarget = null;

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (isDragging) {
      isDragging = false;
      document.body.classList.remove('is-dragging', 'dragging-task', 'dragging-project', 'dragging-section');
      if (ghostEl) {
        ghostEl.remove();
        ghostEl = null;
      }
      if (currentDropTarget) {
        currentDropTarget.dispatchEvent(new CustomEvent('dragleave', { bubbles: true }));
        currentDropTarget = null;
      }
      if (draggedEl) {
        draggedEl.dispatchEvent(new CustomEvent('dragend', { bubbles: true }));
        draggedEl = null;
      }
      app.draggedTaskId = null;
      app.draggedProjectId = null;
      app.draggedSectionId = null;
      app.dragJustEnded = true;
      setTimeout(() => {
        app.dragJustEnded = false;
      }, 350);
    }
    touchStart = null;
  };

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) {
      cancel();
      return;
    }

    const target = e.target;
    // Don't trigger drag on buttons, inputs, checkboxes, or links
    if (target.closest('button, input, select, textarea, a, .task-check, .popover-menu')) {
      return;
    }

    const draggable = target.closest('.task-row, .project-row, .section-header');
    if (!draggable) return;

    const touch = e.touches[0];
    touchStart = {
      x: touch.clientX,
      y: touch.clientY,
      target: draggable,
    };

    timer = setTimeout(() => {
      if (!touchStart) return;
      isDragging = true;
      draggedEl = draggable;

      try {
        if (navigator.vibrate) navigator.vibrate(30);
      } catch (_) {}

      // Create Ghost element
      const rect = draggable.getBoundingClientRect();
      const offsetX = touchStart.x - rect.left;
      const offsetY = touchStart.y - rect.top;
      touchStart.offsetX = offsetX;
      touchStart.offsetY = offsetY;

      ghostEl = draggable.cloneNode(true);
      ghostEl.style.position = 'fixed';
      ghostEl.style.left = `${rect.left}px`;
      ghostEl.style.top = `${rect.top}px`;
      ghostEl.style.width = `${rect.width}px`;
      ghostEl.style.height = `${rect.height}px`;
      ghostEl.style.opacity = '0.9';
      ghostEl.style.pointerEvents = 'none';
      ghostEl.style.zIndex = '9999';
      ghostEl.style.boxShadow = '0 16px 36px rgba(0, 0, 0, 0.45)';
      ghostEl.style.transform = 'scale(1.02)';
      ghostEl.style.transition = 'transform 0.1s ease';
      document.body.appendChild(ghostEl);

      // Trigger standard dragstart event on dragged element
      const dt = new DataTransfer();
      if (draggable.classList.contains('task-row')) {
        const taskId = draggable.dataset.id;
        app.draggedTaskId = taskId;
        dt.setData('task-id', taskId);
        document.body.classList.add('is-dragging', 'dragging-task');
      } else if (draggable.classList.contains('project-row')) {
        const projId = draggable.dataset.id;
        app.draggedProjectId = projId;
        dt.setData('project-id', projId);
        document.body.classList.add('is-dragging', 'dragging-project');
      } else if (draggable.classList.contains('section-header')) {
        const secBlock = draggable.closest('.section-block');
        const secId = secBlock?.dataset.sectionId;
        if (secId) {
          app.draggedSectionId = secId;
          dt.setData('section-id', secId);
          document.body.classList.add('is-dragging', 'dragging-section');
        }
      }

      const dragEvent = new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
        dataTransfer: dt,
      });
      draggable.dispatchEvent(dragEvent);
    }, 200);
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!touchStart) return;

    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - touchStart.x);
    const dy = Math.abs(touch.clientY - touchStart.y);

    if (!isDragging) {
      if (dx > 14 || dy > 14) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
      return;
    }

    // Is dragging
    e.preventDefault();

    if (ghostEl) {
      const ox = touchStart.offsetX ?? 20;
      const oy = touchStart.offsetY ?? 20;
      ghostEl.style.left = `${touch.clientX - ox}px`;
      ghostEl.style.top = `${touch.clientY - oy}px`;
    }

    // Auto-scroll when near top or bottom of container
    const isInsideSidebar = !!draggedEl?.closest('.sidebar');
    const scrollContainer = isInsideSidebar
      ? (document.getElementById('projects-tree') || document.querySelector('.sidebar'))
      : (document.querySelector('.main-content') || window);

    const edgeMargin = 75;
    if (touch.clientY < edgeMargin) {
      const factor = (edgeMargin - touch.clientY) / edgeMargin;
      scrollContainer.scrollBy?.(0, -Math.round(factor * 14));
    } else if (touch.clientY > window.innerHeight - edgeMargin) {
      const factor = (touch.clientY - (window.innerHeight - edgeMargin)) / edgeMargin;
      scrollContainer.scrollBy?.(0, Math.round(factor * 14));
    }

    // Determine drop target under finger
    ghostEl.style.visibility = 'hidden';
    const targetUnderFinger = document.elementFromPoint(touch.clientX, touch.clientY);
    ghostEl.style.visibility = 'visible';

    if (!targetUnderFinger) return;

    const dropTarget = targetUnderFinger.closest(
      '.task-row, .task-list, .section-block, .project-row, .nav-item'
    );

    if (currentDropTarget && currentDropTarget !== dropTarget) {
      currentDropTarget.dispatchEvent(new CustomEvent('dragleave', { bubbles: true }));
    }

    currentDropTarget = dropTarget;

    if (dropTarget) {
      const dt = new DataTransfer();
      const dragOverEvent = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
        dataTransfer: dt,
      });
      dropTarget.dispatchEvent(dragOverEvent);
    }
  }, { passive: false });

  document.addEventListener('touchend', (e) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    if (!isDragging) {
      touchStart = null;
      return;
    }

    e.preventDefault();

    const touch = e.changedTouches[0];
    if (ghostEl) {
      ghostEl.style.visibility = 'hidden';
    }
    const targetUnderFinger = document.elementFromPoint(touch.clientX, touch.clientY);

    const dropTarget = targetUnderFinger?.closest(
      '.task-row, .task-list, .section-block, .project-row, .nav-item'
    );

    if (dropTarget) {
      const dt = new DataTransfer();
      if (app.draggedTaskId) dt.setData('task-id', app.draggedTaskId);
      if (app.draggedProjectId) dt.setData('project-id', app.draggedProjectId);
      if (app.draggedSectionId) dt.setData('section-id', app.draggedSectionId);

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
        dataTransfer: dt,
      });
      dropTarget.dispatchEvent(dropEvent);
    }

    cancel();
  }, { passive: false });

  document.addEventListener('touchcancel', cancel);
}
