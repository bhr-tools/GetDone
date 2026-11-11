// Files attached to a task: a ticket, a photo, a document. Shown under the
// description as small thumbnails (images) or chips (other files), opened
// through their signed link, which also works in the viewer iOS opens from a
// home screen app. Adding or removing a file needs the network.

import { h, icon } from '../dom.js';
import { api } from '../api.js';
import { toast } from '../ui/overlay.js';

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const isImage = (a) => a.content_type.startsWith('image/');

/**
 * The files block of a task's details. onAttach opens the file picker;
 * onRemove(attachment) deletes one file.
 */
export function attachmentsBlock(task, { onAttach, onRemove }) {
  const files = task.attachments || [];
  const remove = (a) => h('button', {
    type: 'button', class: 'file-remove', title: `Remove ${a.filename}`,
    attrs: { 'aria-label': `Remove ${a.filename}` },
    onclick: (e) => { e.preventDefault(); onRemove(a); },
  }, icon('close'));
  const chip = (a) => h('a', { class: 'file-chip', href: a.url, target: '_blank', rel: 'noopener', title: a.filename },
    icon('paperclip'), h('span', { class: 'file-name' }, a.filename), h('span', { class: 'file-size' }, formatSize(a.size)));

  const items = files.map((a) => {
    if (!isImage(a)) return h('div', { class: 'file-item' }, chip(a), remove(a));
    const img = h('img', { src: a.url, alt: a.filename, loading: 'lazy', decoding: 'async' });
    const item = h('div', { class: 'file-item' },
      h('a', { class: 'file-thumb', href: a.url, target: '_blank', rel: 'noopener', title: `${a.filename} · ${formatSize(a.size)}` }, img),
      remove(a));
    // Formats this browser cannot show (HEIC outside Safari): a chip instead.
    img.addEventListener('error', () => item.firstChild.replaceWith(chip(a)), { once: true });
    return item;
  });
  const add = h('button', {
    type: 'button', class: ['file-add', files.length && 'compact'], title: 'Attach a file (f)', onclick: onAttach,
  }, icon(files.length ? 'plus' : 'paperclip'), files.length ? null : h('span', null, 'Attach a file'));
  return h('div', { class: 'detail-files' }, ...items, add);
}

/** Opens the system file picker (on iOS: photo library, camera or files). */
export function pickFiles(onFiles) {
  const input = h('input', { type: 'file', multiple: true });
  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    if (files.length) onFiles(files);
  });
  input.click();
}

/** Uploads files to a task, with the progress in a toast. Resolves to true on success. */
export async function uploadFiles(taskId, files, reportError) {
  const total = files.reduce((n, f) => n + f.size, 0);
  const label = files.length === 1 ? files[0].name : `${files.length} files`;
  toast(`Uploading ${label} (${formatSize(total)})…`);
  let last = 0;
  try {
    await api.attachments.upload(taskId, files, (fraction) => {
      const pct = Math.floor(fraction * 100);
      if (pct - last >= 10 || pct === 100) {
        last = pct;
        toast(`Uploading ${label}: ${pct}%`);
      }
    });
    toast(files.length === 1 ? `Attached ${files[0].name}` : `Attached ${files.length} files`, { type: 'success' });
    return true;
  } catch (err) {
    reportError(err);
    return false;
  }
}
