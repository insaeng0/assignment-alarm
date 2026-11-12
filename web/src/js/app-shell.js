// Keep the shared navigation in one place while retaining each page's active link.
const appHeader = document.querySelector('.app-header');
if (appHeader) {
  const paths = {
    'calendar.html': '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/>',
    'register.html': '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8m-8 4h5m-1 3v4m-2-2h4"/>',
    'messages.html': '<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 2-2Z"/><path d="M8 9h9m-9 4h6"/>',
    'settings.html': '<path d="m9 3-1 3-3 1v4l-2 1 2 2v4l3 1 1 2h6l1-2 3-1v-4l2-2-2-1V7l-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>'
  };
  const sidebar = document.createElement('aside');
  sidebar.className = 'workspace-sidebar';
  const brand = appHeader.querySelector('.brand');
  const nav = appHeader.querySelector('nav');
  const currentLabel = nav?.querySelector('[aria-current="page"]')?.textContent || '우리 반';
  if (brand) sidebar.appendChild(brand);
  const caption = document.createElement('p');
  caption.className = 'sidebar-caption';
  caption.textContent = '나의 학교생활';
  sidebar.appendChild(caption);
  if (nav) {
    nav.querySelectorAll('a').forEach((link) => {
      const path = paths[link.getAttribute('href')];
      if (path) link.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`);
    });
    sidebar.appendChild(nav);
  }
  sidebar.insertAdjacentHTML('beforeend', '<div class="sidebar-bottom"><div class="sidebar-note"><svg viewBox="0 0 80 60" fill="none" aria-hidden="true"><path d="M40 52V27m0 16C20 43 18 26 19 18c16 0 22 10 21 25Zm0-10C39 15 51 8 64 9c0 13-8 26-24 24Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="m26 26 14 17m14-25L40 33" stroke="currentColor" stroke-width="1.5"/></svg><strong>우리 반 학습 플래너</strong><p>과제와 공지를 한곳에서.</p></div><span class="sidebar-footer">과제 알리미 <span>OUR CLASS</span></span></div>');
  appHeader.before(sidebar);
  const breadcrumb = document.createElement('div');
  breadcrumb.className = 'workspace-breadcrumb';
  const rootLabel = document.createElement('span');
  rootLabel.textContent = '우리 반';
  const current = document.createElement('strong');
  current.textContent = currentLabel;
  breadcrumb.append(rootLabel, document.createTextNode(' / '), current);
  appHeader.prepend(breadcrumb);
  const todayLabel = document.querySelector('[data-today-label]');
  if (todayLabel) todayLabel.textContent = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
}

window.AppUI = {
  localDate(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  },
  toast(message, error = false) {
    let el = document.getElementById('appToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'appToast';
      el.className = 'app-toast';
      document.body.appendChild(el);
    }
    clearTimeout(this.toastTimer);
    el.textContent = String(message || '');
    el.classList.toggle('error', error);
    el.setAttribute('role', error ? 'alert' : 'status');
    el.classList.add('show');
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), 5000);
  }
};

document.querySelectorAll('[data-nav]').forEach((element) => {
  element.addEventListener('click', () => {
    const target = element.dataset.nav;
    if (target) window.location.href = target;
  });
});
document.querySelectorAll('[data-logout]').forEach((element) => {
  element.addEventListener('click', () => API.logout());
});
document.querySelectorAll('form[data-prevent-submit="true"]').forEach((form) => {
  form.addEventListener('submit', (event) => event.preventDefault());
});

const notificationPanel = document.getElementById('notificationPanel');
const notificationButton = document.getElementById('notificationBtn');
if (notificationPanel && notificationButton) {
  new MutationObserver(() => {
    notificationButton.setAttribute('aria-expanded', String(notificationPanel.classList.contains('show')));
  }).observe(notificationPanel, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && notificationPanel.classList.contains('show')) {
      notificationPanel.classList.remove('show');
      notificationButton.focus();
    }
  });
}
