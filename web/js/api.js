// HTTP client for the Get Done API. Every call returns the decoded JSON or
// throws an ApiError whose message can be shown to the user.

import { todayISO } from './dates.js';
import { ApiError } from './errors.js';
import { SyncEngine, newId } from './sync/engine.js';
import { EMPTY, fromSnapshot, projectTree, getProject, listSections, getTask, listTasks, searchTasks, counts } from './sync/state.js';
import { reduce } from './sync/reduce.js';

export { ApiError };

/** Local data, kept in sync with the server (see sync/engine.js). */
export const engine = new SyncEngine({ dbName: 'getdone', empty: EMPTY, fromSnapshot, reduce });

// Reads answer from the local state; errors become rejected promises, as
// with the network.
const local = (fn) => Promise.resolve().then(() => fn(engine.state));
const change = (type, args) => engine.mutate(type, args);

let unauthorizedHandler = () => {};

/** Called whenever the server says the session is no longer valid. */
export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

async function request(method, path, body) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection.', 0);
  }

  let data = null;
  if ((res.headers.get('Content-Type') || '').includes('application/json')) {
    data = await res.json().catch(() => null);
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) unauthorizedHandler();
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

const get = (path) => request('GET', path);
const post = (path, body = {}) => request('POST', path, body);
const patch = (path, body) => request('PATCH', path, body);
const del = (path) => request('DELETE', path);
const id = encodeURIComponent;

export const api = {
  auth: {
    status: () => get('/api/auth/status'),
    setup: (password) => post('/api/auth/setup', { password }),
    login: (password) => post('/api/auth/login', { password }),
    logout: () => post('/api/auth/logout'),
    changePassword: (oldPassword, newPassword) =>
      post('/api/auth/change-password', { old_password: oldPassword, new_password: newPassword }),
  },

  projects: {
    list: () => local((s) => projectTree(s)),
    get: (projectId) => local((s) => getProject(s, projectId)),
    create: (name, parentId) => change('project.create', { id: newId(), name, parent_id: parentId || null }),
    rename: (projectId, name) => change('project.rename', { id: projectId, name }),
    remove: (projectId) => change('project.delete', { id: projectId }),
    /** placement: { before_id } | { after_id } | {} (end) */
    move: (projectId, parentId, placement = {}) =>
      change('project.move', { id: projectId, parent_id: parentId || null, ...placement }),
    setSort: (projectId, sortBy) => change('project.sort', { id: projectId, sort_by: sortBy }),
    async exportCSV(projectId) {
      const res = await fetch(`/api/projects/${id(projectId)}/export`, { credentials: 'same-origin' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new ApiError(data?.error || 'Export failed', res.status);
      }
      const disposition = res.headers.get('Content-Disposition') || '';
      const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/);
      const plain = disposition.match(/filename="([^"]+)"/);
      const filename = utf8 ? decodeURIComponent(utf8[1]) : plain ? plain[1] : 'export.csv';
      return { blob: await res.blob(), filename };
    },
    importCSV: (projectId, file) => {
      const form = new FormData();
      form.append('file', file);
      return request('POST', `/api/projects/${id(projectId)}/import?today=${todayISO()}`, form);
    },
  },

  sections: {
    list: (projectId) => local((s) => listSections(s, projectId)),
    create: (projectId, name) => change('section.create', { id: newId(), project_id: projectId, name }),
    rename: (sectionId, name) => change('section.rename', { id: sectionId, name }),
    remove: (sectionId) => change('section.delete', { id: sectionId }),
    move: (sectionId, projectId, placement = {}) =>
      change('section.move', { id: sectionId, project_id: projectId || '', ...placement }),
  },

  tasks: {
    list: (view, { projectId = '', sort = 'manual' } = {}) =>
      local((s) => listTasks(s, view, projectId, sort, todayISO())),
    get: (taskId) => local((s) => getTask(s, taskId)),
    create: (task) => change('task.create', { ...task, id: newId() }),
    update: (taskId, fields) => change('task.update', { id: taskId, fields }),
    /** target: { project_id, section_id, parent_id, before_id, after_id } */
    move: (taskId, target) => change('task.move', { id: taskId, ...target }),
    remove: (taskId) => change('task.delete', { id: taskId }),
    complete: (taskId) => change('task.complete', {
      id: taskId, today: todayISO(), due_date: engine.state.tasks[taskId]?.due_date ?? null,
    }),
    restore: (tasks, updates) => change('task.restore', { tasks, updates }),
  },

  attachments: {
    /**
     * Uploads files to a task; onProgress gets the fraction sent (0 to 1).
     * Needs the network, and the task on the server: changes still queued
     * are sent first. The new files reach the local state with the next sync.
     */
    async upload(taskId, files, onProgress) {
      if (engine.pending) await engine.sync();
      if (engine.pending || navigator.onLine === false) {
        throw new ApiError('Attaching files needs a connection.', 0);
      }
      await new Promise((resolve, reject) => {
        const form = new FormData();
        for (const f of files) form.append('file', f, f.name);
        const xhr = new XMLHttpRequest(); // fetch cannot report upload progress
        xhr.open('POST', `/api/tasks/${id(taskId)}/attachments`);
        xhr.withCredentials = true;
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
        xhr.onload = () => {
          let data = null;
          try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
          if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
          if (xhr.status === 401) unauthorizedHandler();
          reject(new ApiError(data?.error || `Upload failed (${xhr.status})`, xhr.status));
        };
        xhr.onerror = () => reject(new ApiError('Cannot reach the server. Check your connection.', 0));
        xhr.send(form);
      });
      await engine.sync();
    },
    async remove(attId) {
      await del(`/api/attachments/${id(attId)}`);
      await engine.sync();
    },
    async restore(attId) {
      await post(`/api/attachments/${id(attId)}/restore`);
      await engine.sync();
    },
  },

  /** fields: { project_id } or { new_project } */
  connect: (app, redirectUri, fields) => post('/api/connect', { app, redirect_uri: redirectUri, ...fields }),
  apps: {
    list: () => get('/api/apps'),
    remove: (appId) => del(`/api/apps/${id(appId)}`),
  },

  search: (query) => local((s) => searchTasks(s, query)),
  counts: () => local((s) => counts(s, todayISO())),
};
