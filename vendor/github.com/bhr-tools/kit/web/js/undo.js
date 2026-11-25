// Undo stack (key u in every app). An entry is pushed as soon as the action
// starts, before the server answers, so that a fast u undoes this action and
// not the one before; cancel it if the action turns out to do nothing.
//
//   const undo = createUndo({ toast });
//   const entry = undo.push({ label: 'Task completed', undo: () => api.reopen(id) });
//   …on failure: entry.cancel();
//   key u: undo.run();
//
// Without the DOM: the toast function comes from overlay.js.

export const UNDO_LIMIT = 50;

export function createUndo({ toast = () => {}, limit = UNDO_LIMIT } = {}) {
  const stack = [];

  /**
   * Records how to undo an action and offers it in a toast (unless
   * quiet). entry: { label, undo: async () => {} }. Returns { cancel }.
   */
  function push(entry, { quiet = false } = {}) {
    stack.push(entry);
    if (stack.length > limit) stack.shift();
    if (!quiet) toast(entry.label, { action: { label: 'Undo', run: () => run() } });
    return {
      cancel() {
        const i = stack.indexOf(entry);
        if (i >= 0) stack.splice(i, 1);
      },
    };
  }

  /** Undoes the latest action. Resolves to true when something was undone. */
  async function run() {
    const entry = stack.pop();
    if (!entry) {
      toast('Nothing to undo');
      return false;
    }
    try {
      await entry.undo();
    } catch (err) {
      stack.push(entry); // keep it to try again
      toast(err?.message || 'Could not undo', { type: 'error' });
      return false;
    }
    toast(`Undone: ${entry.label.charAt(0).toLowerCase()}${entry.label.slice(1)}`);
    return true;
  }

  return { push, run, get size() { return stack.length; } };
}
