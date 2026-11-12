const initialToday = new Date();
let currentDate = new Date(initialToday.getFullYear(), initialToday.getMonth(), 1);
let assignments = [];
let assignmentsLoading = false;
let assignmentsError = false;
let loadVersion = 0;
let adminGradeFilter = 'all';
let adminClassFilter = 'all';
let taskFilter = 'all';
let taskSearch = '';
let modalDate = null;
let previousFocus = null;
const isCompleted = (task) => Number(task.is_completed) === 1 || task.is_completed === true;
const dateString = (date) => AppUI.localDate(date);

API.requireAuth();

async function init() {
  try {
    const cachedUser = API.getUser();
    if (cachedUser) {
      API.loadUserInfo();
      initAdminFilters(cachedUser);
      renderCalendar(true);
    }
    const user = await API.ensureUser();
    if (!user) return;
    API.loadUserInfo();
    API.initNotifications().catch(() => {});
    initAdminFilters(user);
    await loadAssignments(user);
  } catch {
    assignmentsError = true;
    assignmentsLoading = false;
    renderCalendar();
  }
}

async function loadAssignments(user = API.getUser()) {
  if (!user) return;
  const requestVersion = ++loadVersion;
  assignmentsLoading = true;
  assignmentsError = false;
  renderCalendar();
  try {
    const data = user.is_admin
      ? await API.getAssignments()
      : await API.getUserAssignmentsWithDetails(user.id);
    if (requestVersion !== loadVersion) return;
    if (!Array.isArray(data)) throw new Error(data?.error || 'load-failed');
    assignments = data;
  } catch {
    if (requestVersion === loadVersion) assignmentsError = true;
  } finally {
    if (requestVersion === loadVersion) {
      assignmentsLoading = false;
      renderCalendar();
    }
  }
}

function initAdminFilters(user) {
  if (!user?.is_admin) return;
  document.getElementById('adminCalendarFilter').classList.add('show');
  const grade = document.getElementById('adminGradeFilter');
  const classNumber = document.getElementById('adminClassFilter');
  grade.innerHTML = '<option value="all">전체 학년</option>' + Array.from({ length: 3 }, (_, i) => `<option value="${i + 1}">${i + 1}학년</option>`).join('');
  classNumber.innerHTML = '<option value="all">전체 반</option>' + Array.from({ length: 4 }, (_, i) => `<option value="${i + 1}">${i + 1}반</option>`).join('');
  grade.value = adminGradeFilter;
  classNumber.value = adminClassFilter;
}

function getVisibleAssignments() {
  if (!API.getUser()?.is_admin) return assignments;
  return assignments.filter((task) => (adminGradeFilter === 'all' || String(task.target_grade) === adminGradeFilter) && (adminClassFilter === 'all' || String(task.target_class) === adminClassFilter));
}
function getMatchingAssignments() {
  return getVisibleAssignments().filter((task) => {
    const stateMatches = taskFilter === 'all' || (taskFilter === 'done' ? isCompleted(task) : !isCompleted(task));
    return stateMatches && String(task.title || '').toLocaleLowerCase('ko').includes(taskSearch);
  });
}
function urgentDate() {
  const threshold = new Date();
  threshold.setDate(threshold.getDate() + 2);
  return dateString(threshold);
}

function renderCalendar(forceLoading = assignmentsLoading) {
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const user = API.getUser();
  const visible = getVisibleAssignments();
  const matching = getMatchingAssignments();
  const today = dateString(new Date());
  const threshold = urgentDate();
  document.getElementById('monthTitle').textContent = `${year}년 ${month + 1}월`;
  document.getElementById('classScope').textContent = user?.is_admin
    ? `${adminGradeFilter === 'all' ? '전체 학년' : adminGradeFilter + '학년'} · ${adminClassFilter === 'all' ? '전체 반' : adminClassFilter + '반'}`
    : user?.grade && user?.class_number ? `${user.grade}학년 ${user.class_number}반의 과제 캘린더` : '';
  document.getElementById('calendarLoadingBanner').hidden = !forceLoading;
  document.getElementById('calendarError').hidden = !assignmentsError;
  document.getElementById('calendarBody').setAttribute('aria-busy', String(forceLoading));
  const firstDay = new Date(year, month, 1).getDay();
  const lastDate = new Date(year, month + 1, 0).getDate();
  let html = '<div class="day empty" aria-hidden="true"></div>'.repeat(firstDay);
  for (let d = 1; d <= lastDate; d += 1) {
    const date = dateString(new Date(year, month, d));
    const tasks = matching.filter((task) => task.due_date === date).sort((a, b) => Number(isCompleted(a)) - Number(isCompleted(b)));
    const tags = tasks.slice(0, 2).map((task) => {
      const cls = isCompleted(task) ? 'done' : task.due_date <= threshold ? 'urgent' : 'normal';
      const title = user?.is_admin ? `${task.target_grade}학년 ${task.target_class}반 · ${task.title}` : task.title;
      return `<span class="task-tag ${cls}">${API.escapeHTML(title)}</span>`;
    }).join('');
    const label = `${month + 1}월 ${d}일${date === today ? ', 오늘' : ''}, 과제 ${tasks.length}개`;
    html += `<button type="button" class="day${date === today ? ' today' : ''}" data-date="${date}" aria-label="${label}"${date === today ? ' aria-current="date"' : ''}><span class="date">${d}</span>${tags}${tasks.length > 2 ? `<span class="task-more">+${tasks.length - 2}개 더</span>` : ''}</button>`;
  }
  html += '<div class="day empty" aria-hidden="true"></div>'.repeat((7 - (firstDay + lastDate) % 7) % 7);
  document.getElementById('calendarBody').innerHTML = html;
  updateOverview(visible, forceLoading);
}

function updateOverview(visible, loading) {
  const pending = visible.filter((task) => !isCompleted(task));
  const completed = visible.length - pending.length;
  const urgent = pending.filter((task) => task.due_date <= urgentDate()).length;
  for (const [id, count] of [['urgentCount', urgent], ['normalCount', pending.length - urgent], ['doneCount', completed]]) {
    document.getElementById(id).textContent = loading ? '—' : count;
  }
  document.getElementById('upcomingCount').textContent = loading ? '—' : `${pending.length}개`;
  const list = document.getElementById('upcomingList');
  if (loading) list.innerHTML = '<div class="empty-state">과제를 불러오는 중입니다…</div>';
  else if (assignmentsError && visible.length === 0) list.innerHTML = '<div class="empty-state">잠시 후 다시 시도해주세요.</div>';
  else if (pending.length === 0) list.innerHTML = `<div class="empty-state">${visible.length ? '모든 과제를 제출했어요!<br>잠깐 쉬어가도 좋아요.' : '아직 등록된 과제가 없어요.<br>새 과제를 등록해보세요.'}</div>`;
  else {
    const today = new Date();
    const todayUTC = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    list.innerHTML = pending.slice().sort((a, b) => a.due_date.localeCompare(b.due_date) || Number(a.assignment_id) - Number(b.assignment_id)).slice(0, 5).map((task) => {
      const [year, month, day] = task.due_date.split('-').map(Number);
      const days = Math.round((Date.UTC(year, month - 1, day) - todayUTC) / 86400000);
      const label = days < 0 ? '기한 지남' : days === 0 ? '오늘' : `D–${days}`;
      const dateLabel = `${month}월 ${day}일 · ${API.escapeHTML(task.creator_name || '우리 반')}`;
      return `<button type="button" class="upcoming-item" data-date="${API.escapeHTML(task.due_date)}"><span class="due-chip${days <= 2 ? ' urgent' : ''}">${label}</span><span class="upcoming-info"><span class="upcoming-title">${API.escapeHTML(task.title)}</span><span class="upcoming-date">${dateLabel}</span></span></button>`;
    }).join('');
  }
  const percentage = visible.length ? Math.round(completed / visible.length * 100) : 0;
  document.getElementById('progressPercent').textContent = loading ? '—' : `${percentage}%`;
  document.getElementById('progressCount').textContent = loading ? '불러오는 중' : `${completed} / ${visible.length}개 완료`;
  document.getElementById('progressBar').style.width = `${percentage}%`;
  document.getElementById('assignmentProgress').setAttribute('aria-valuenow', String(percentage));
  document.getElementById('progressDescription').textContent = pending.length ? `미제출 과제가 ${pending.length}개 남아 있어요.` : visible.length ? '모든 과제를 제출했어요.' : '등록된 과제가 없습니다.';
}

function openModal(date, { allTasks = false, keepFocus = false } = {}) {
  modalDate = date;
  if (!keepFocus) previousFocus = document.activeElement;
  const tasks = (allTasks ? getVisibleAssignments() : getMatchingAssignments()).filter((task) => task.due_date === date);
  const user = API.getUser();
  const [year, month, day] = date.split('-').map(Number);
  document.getElementById('modalTitle').textContent = `${year}년 ${month}월 ${day}일 과제`;
  document.getElementById('taskList').innerHTML = tasks.length ? tasks.map((task) => `<div class="assignment-item${isCompleted(task) ? ' done' : ''}"><div class="info"><div class="title">${API.escapeHTML(task.title)}</div>${task.content ? `<div class="detail">${API.renderTextWithLinks(task.content)}</div>` : ''}<div class="meta">${API.escapeHTML(task.creator_name || '우리 반')} · ${user?.is_admin ? `${task.target_grade}학년 ${task.target_class}반` : isCompleted(task) ? '제출 완료' : '미제출'}</div></div><div class="actions">${!user?.is_admin ? `<label class="submit-check"><input type="checkbox" class="modal-submit-toggle" data-id="${Number(task.assignment_id)}" ${isCompleted(task) ? 'checked' : ''}><span>제출 완료</span></label>` : ''}${user && (Number(task.created_by) === Number(user.id) || user.is_admin) ? `<button type="button" class="btn btn-danger btn-sm modal-delete" data-id="${Number(task.assignment_id)}">삭제</button>` : ''}</div></div>`).join('') : '<div class="empty-state">이 날짜에 표시할 과제가 없어요.<br>필터를 확인하거나 새 과제를 등록해보세요.</div><a class="btn btn-primary" href="register.html">새 과제 등록</a>';
  document.getElementById('modal').classList.add('show');
  document.body.classList.add('modal-open');
  if (!keepFocus || !document.getElementById('modal').contains(document.activeElement)) document.querySelector('#modal .modal-content').focus();
}
function closeModal() {
  document.getElementById('modal').classList.remove('show');
  document.body.classList.remove('modal-open');
  modalDate = null;
  if (previousFocus?.isConnected) previousFocus.focus();
  else document.getElementById('todayMonth').focus();
}

document.getElementById('calendarBody').addEventListener('click', (event) => {
  const day = event.target.closest('[data-date]');
  if (day && !assignmentsLoading) openModal(day.dataset.date);
});
document.getElementById('upcomingList').addEventListener('click', (event) => {
  const item = event.target.closest('[data-date]');
  if (item) openModal(item.dataset.date, { allTasks: true });
});
document.getElementById('taskList').addEventListener('click', async (event) => {
  const button = event.target.closest('.modal-delete');
  if (!button || button.disabled) return;
  const id = Number(button.dataset.id);
  if (!id || !confirm('이 과제를 삭제할까요? 삭제하면 되돌릴 수 없습니다.')) return;
  button.disabled = true;
  try {
    const result = await API.deleteAssignment(id);
    if (!result?.success) throw new Error(result?.error || '과제를 삭제하지 못했습니다.');
    assignments = assignments.filter((task) => Number(task.assignment_id) !== id);
    renderCalendar();
    if (modalDate) openModal(modalDate, { allTasks: true, keepFocus: true });
    AppUI.toast('과제가 삭제되었습니다.');
    API.refreshNotifications().catch(() => {});
  } catch (error) {
    button.disabled = false;
    AppUI.toast(error.message || '삭제하지 못했습니다. 다시 시도해주세요.', true);
  }
});
document.getElementById('taskList').addEventListener('change', async (event) => {
  const checkbox = event.target.closest('.modal-submit-toggle');
  if (!checkbox || checkbox.disabled) return;
  const id = Number(checkbox.dataset.id);
  const completed = checkbox.checked;
  checkbox.disabled = true;
  try {
    const result = await API.toggleAssignment(id, completed);
    if (!result?.success) throw new Error(result?.error || '제출 상태를 저장하지 못했습니다.');
    const task = assignments.find((item) => Number(item.assignment_id) === id);
    if (task) task.is_completed = completed ? 1 : 0;
    renderCalendar();
    const item = checkbox.closest('.assignment-item');
    item?.classList.toggle('done', completed);
    if (item && task) item.querySelector('.meta').textContent = `${task.creator_name || '우리 반'} · ${completed ? '제출 완료' : '미제출'}`;
    AppUI.toast(completed ? '제출 완료로 표시했어요.' : '미제출로 변경했어요.');
  } catch (error) {
    checkbox.checked = !completed;
    AppUI.toast(error.message || '상태를 저장하지 못했습니다. 다시 시도해주세요.', true);
  } finally { checkbox.disabled = false; }
});
function changeMonth(offset) {
  currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + offset, 1);
  renderCalendar();
}
document.getElementById('prevMonth').addEventListener('click', () => changeMonth(-1));
document.getElementById('nextMonth').addEventListener('click', () => changeMonth(1));
document.getElementById('todayMonth').addEventListener('click', () => {
  const today = new Date(); currentDate = new Date(today.getFullYear(), today.getMonth(), 1); renderCalendar();
});
document.querySelectorAll('[data-task-filter]').forEach((button) => button.addEventListener('click', () => {
  taskFilter = button.dataset.taskFilter;
  document.querySelectorAll('[data-task-filter]').forEach((item) => {
    const selected = item === button;
    item.classList.toggle('active', selected); item.setAttribute('aria-pressed', String(selected));
  });
  renderCalendar();
}));
document.getElementById('taskSearch').addEventListener('input', (event) => { taskSearch = event.target.value.trim().toLocaleLowerCase('ko'); renderCalendar(); });
document.getElementById('adminGradeFilter').addEventListener('change', (event) => {
  adminGradeFilter = event.target.value;
  if (adminGradeFilter === 'all') { adminClassFilter = 'all'; document.getElementById('adminClassFilter').value = 'all'; }
  renderCalendar();
});
document.getElementById('adminClassFilter').addEventListener('change', (event) => { adminClassFilter = event.target.value; renderCalendar(); });
document.getElementById('retryAssignments').addEventListener('click', () => { if (!assignmentsLoading) loadAssignments(); });
document.getElementById('closeModal').addEventListener('click', closeModal);
document.getElementById('modal').addEventListener('click', (event) => { if (event.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (event) => {
  const modal = document.getElementById('modal');
  if (!modal.classList.contains('show')) return;
  if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(modal.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]')).filter((element) => element.getClientRects().length);
  const first = focusable[0]; const last = focusable[focusable.length - 1];
  if (!first) { event.preventDefault(); return; }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === modal.querySelector('.modal-content'))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
init();
