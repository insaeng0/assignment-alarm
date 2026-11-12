let entryChecking = false;
async function routeEntry() {
  if (entryChecking) return;
  entryChecking = true;
  const status = document.getElementById('entryStatus');
  const retry = document.getElementById('entryRetry');
  retry.hidden = true;
  status.textContent = '로그인 상태를 확인하고 있어요.';
  const destination = page => API.appPageUrl(page) + (window.location.search || '') + (window.location.hash || '');
  try {
    if (API.getAuthMode() === 'bearer' && !API.getToken()) {
      // A signed-out visitor needs no server round trip and never enters the
      // calendar. Remembered sessions are restored on this neutral entry page.
      const remembered = await API.readRememberedSession();
      if (!remembered) { window.location.replace(destination('login.html')); return; }
    }
    const user = await API.ensureUser();
    window.location.replace(destination(user?.id ? 'calendar.html' : 'login.html'));
  } catch (error) {
    // A temporary outage must not turn a remembered login into a sign-out.
    status.textContent = error?.message || '로그인 상태를 확인하지 못했습니다. 다시 시도해주세요.';
    retry.hidden = false;
  } finally { entryChecking = false; }
}
document.getElementById('entryRetry').addEventListener('click', routeEntry);
routeEntry();
