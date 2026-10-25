// Sidebar: inbox and upcoming entries with their counts, and the project tree.

import { h, icon } from '../dom.js';
import { openMenu } from '../ui/overlay.js';

export function renderSidebar(app, nav, tree) {
  const s = app.state;
  const navItem = (view, label, iconName, count) => h('button', {
    type: 'button',
    class: ['nav-item', s.view === view && 'active'],
    dataset: { nav: view, ...(view === 'inbox' ? { drop: 'inbox' } : {}) },
    onclick: () => app.switchView(view),
  }, icon(iconName), h('span', { class: 'nav-label' }, label), h('span', { class: 'nav-count' }, count || ''));

  nav.replaceChildren(
    navItem('inbox', 'Inbox', 'inbox', s.counts.inbox),
    navItem('upcoming', 'Upcoming', 'calendar', s.counts.upcoming));

  tree.replaceChildren(...s.projects.map((p) => projectNode(app, p)));
  if (!s.projects.length) {
    tree.append(h('p', { class: 'sidebar-empty' }, 'No projects yet.'));
  }
}

function projectNode(app, project) {
  const s = app.state;
  const status = s.counts.projects?.[project.id];
  const more = h('button', { type: 'button', class: 'icon-button project-more', title: 'Project actions' }, icon('more'));
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(more, [
      { label: 'Rename', icon: 'edit', run: () => app.renameProject(project) },
      'separator',
      { label: 'Delete project', icon: 'trash', danger: true, run: () => app.deleteProject(project) },
    ], { title: project.name });
  });

  const row = h('div', {
    class: ['project-row', s.view === 'project' && s.projectId === project.id && 'active'],
    dataset: { id: project.id, nav: 'project', drag: 'project', drop: 'project' },
    attrs: { role: 'button', tabindex: '-1' },
    onclick: (e) => {
      if (!e.target.closest('button')) app.switchView('project', project.id);
    },
  },
  status
    ? h('span', { class: ['status-dot', status], title: status === 'overdue' ? 'Has overdue tasks' : 'Has tasks due today' })
    : icon('hash', 'project-icon'),
  h('span', { class: 'project-name' }, project.name),
  more);

  return h('div', { class: 'project-node' },
    row,
    project.children?.length ? h('div', { class: 'project-children' }, project.children.map((c) => projectNode(app, c))) : null);
}

/** Rows of the sidebar in visual order, for keyboard navigation. */
export function sidebarRows() {
  return [...document.querySelectorAll('.sidebar [data-nav]')];
}
