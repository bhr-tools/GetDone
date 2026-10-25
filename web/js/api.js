// HTTP client for the Get Done API. Every call returns the decoded JSON or
// throws an ApiError whose message can be shown to the user.

import { todayISO } from './dates.js';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

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
const put = (path, body) => request('PUT', path, body);
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
    list: () => get('/api/projects'),
    get: (projectId) => get(`/api/projects/${id(projectId)}`),
    create: (name, parentId) => post('/api/projects', { name, parent_id: parentId || null }),
    rename: (projectId, name) => patch(`/api/projects/${id(projectId)}`, { name }),
    remove: (projectId) => del(`/api/projects/${id(projectId)}`),
    /** placement: { before_id } | { after_id } | {} (end) */
    move: (projectId, parentId, placement = {}) =>
      post(`/api/projects/${id(projectId)}/move`, { parent_id: parentId || null, ...placement }),
    setSort: (projectId, sortBy) => put(`/api/projects/${id(projectId)}/sort`, { sort_by: sortBy }),
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
    list: (projectId) => get(`/api/sections?project_id=${id(projectId)}`),
    create: (projectId, name) => post('/api/sections', { project_id: projectId, name }),
    rename: (sectionId, name) => patch(`/api/sections/${id(sectionId)}`, { name }),
    remove: (sectionId) => del(`/api/sections/${id(sectionId)}`),
    move: (sectionId, projectId, placement = {}) =>
      post(`/api/sections/${id(sectionId)}/move`, { project_id: projectId || '', ...placement }),
  },

  tasks: {
    list: (view, { projectId = '', sort = 'manual' } = {}) =>
      get(`/api/tasks?view=${view}&project_id=${id(projectId)}&sort=${sort}&today=${todayISO()}`),
    get: (taskId) => get(`/api/tasks/${id(taskId)}`),
    create: (task) => post('/api/tasks', task),
    update: (taskId, fields) => patch(`/api/tasks/${id(taskId)}`, fields),
    /** target: { project_id, section_id, parent_id, before_id, after_id } */
    move: (taskId, target) => post(`/api/tasks/${id(taskId)}/move`, target),
    remove: (taskId) => del(`/api/tasks/${id(taskId)}`),
    complete: (taskId) => post(`/api/tasks/${id(taskId)}/complete`, { today: todayISO() }),
    restore: (tasks, updates) => post('/api/tasks/restore', { tasks, updates }),
  },

  search: (query) => get(`/api/search?q=${id(query)}`),
  counts: () => get(`/api/counts?today=${todayISO()}`),
};
