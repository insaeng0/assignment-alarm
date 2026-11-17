const initialToday = new Date();
let currentDate = new Date(initialToday.getFullYear(), initialToday.getMonth(), 1);
let assignments = [];
let assignmentsLoaded = false;
let assignmentsLoading = false;
let assignmentsError = false;
let loadVersion = 0;
let adminGradeFilter = 'all';
let adminClassFilter = 'all';
let taskFilter = 'all';
let taskSearch = '';
let modalDate = null;
let previousFocus = null;
let modalAllTasks = false;
let assignmentGeneration = 0;
let mutationVersion = 0;
const pendingAssignmentOperations = new Map();
const assignmentDateDrafts = new Map();
let latestMutationFocus = null;
let localViewScope = null;
let viewScopeInitialized = false;
let draggedAssignment = null;
let dragOverDay = null;
let calendarDragPreview = null;
let suppressCalendarClickUntil = 0;
function calendarViewScope(user = API.getUser()) {
  if (!user?.id) return null;
  try {
    const realm = typeof API.getAuthRealm === 'function' ? API.getAuthRealm() : null;
    const origin = typeof API.getApiOrigin === 'function' ? API.getApiOrigin() : window.location?.origin || 'same-origin';
    return JSON.stringify([realm ? 'realm:' + realm : 'origin:' + origin,
      typeof API.getAuthMode === 'function' ? API.getAuthMode() : '', String(user.id), String(user.grade), String(user.class_number),
      user.is_admin === true, user.can_complete_assignments === true]);
  } catch { return null; }
}
function synchronizeViewScope(user = API.getUser()) {
  const nextScope = calendarViewScope(user);
  if (!viewScopeInitialized) {
    viewScopeInitialized = true; localViewScope = nextScope;
    initAdminFilters(user, true);
    return false;
  }
  if (nextScope === localViewScope) return false;
  localViewScope = nextScope;
  assignments = []; assignmentsLoaded = false; assignmentsLoading = false; assignmentsError = false;
  clearCalendarDrag();
  pendingAssignmentOperations.clear(); latestMutationFocus = null;
  assignmentDateDrafts.clear();
  assignmentGeneration++; mutationVersion++; loadVersion++;
  previousFocus = null;
  if (modalDate) closeModal();
  document.getElementById('taskList').innerHTML = '';
  initAdminFilters(user, true);
  // The scope is already bound before rendering, so this cannot recurse again.
  renderCalendar(false);
  return true;
}
function matchesViewScope(scope) {
  synchronizeViewScope();
  return Boolean(scope && scope === localViewScope);
}
function canCompleteAssignment(user, task) {
  if (user?.can_complete_assignments !== true || !task) return false;
  const grade = Number(user.grade);
  const classNumber = Number(user.class_number);
  return Number.isInteger(grade) && grade >= 1 && Number.isInteger(classNumber) && classNumber >= 1
    && Number(task.target_grade) === grade
    && (task.target_class === null || Number(task.target_class) === classNumber);
}
const isCompleted = (task) => canCompleteAssignment(API.getUser(), task) && (Number(task.is_completed) === 1 || task.is_completed === true);
const dateString = (date) => AppUI.localDate(date);
const taskScopeLabel = (task) => `${task.target_grade}학년 ${task.target_class === null ? '전체' : task.target_class + '반'}`;
function taskMeta(task, user) {
  const status = canCompleteAssignment(user, task) ? isCompleted(task) ? '제출 완료' : '미제출' : '열람 전용';
  return `${task.creator_name || '우리 반'} · ${user?.is_admin ? taskScopeLabel(task) + ' · ' : ''}${status}`;
}

function canDeleteAssignment(user, task) {
  return Boolean(user && task && (user.is_admin || Number(task.created_by) === Number(user.id)));
}
function canMoveAssignment(user, task) {
  if (!user?.id || !task) return false;
  if (user.is_admin === true) return true;
  return Number(task.created_by) === Number(user.id)
    && Number(user.grade) >= 1 && Number(user.class_number) >= 1
    && Number(task.target_grade) === Number(user.grade)
    && task.target_class !== null && Number(task.target_class) === Number(user.class_number);
}
function validAssignmentDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1000) return false;
  const date = new Date(value + 'T12:00:00');
  return !Number.isNaN(date.getTime()) && dateString(date) === value;
}
function currentOperation(operation) {
  if (!matchesViewScope(operation.viewScope) || pendingAssignmentOperations.get(operation.id) !== operation || operation.generation !== assignmentGeneration
    || String(API.getUser()?.id) !== operation.userId) return false;
  return operation.kind === 'delete' ? !assignments.some(task => Number(task.assignment_id) === operation.id)
    : assignments.find(task => Number(task.assignment_id) === operation.id) === operation.task;
}
function pendingIncomingAssignments(data, expectedScope = localViewScope) {
  if (!matchesViewScope(expectedScope)) return [];
  const incoming = data.map(task => ({ ...task }));
  assignmentGeneration++;
  for (const operation of pendingAssignmentOperations.values()) {
    if (operation.viewScope !== expectedScope) { pendingAssignmentOperations.delete(operation.id); continue; }
    const index = incoming.findIndex(task => Number(task.assignment_id) === operation.id);
    operation.generation = assignmentGeneration;
    if (operation.kind === 'delete') {
      operation.task = index < 0 ? null : incoming[index];
      if (index >= 0) {
        operation.index = index;
        operation.beforeId = incoming[index - 1]?.assignment_id;
        operation.afterId = incoming[index + 1]?.assignment_id;
        incoming.splice(index, 1);
      }
    } else if (operation.kind === 'move' && index >= 0 && canMoveAssignment(API.getUser(), incoming[index])) {
      operation.task = incoming[index];
      operation.previousDueDate = incoming[index].due_date;
      incoming[index].due_date = operation.nextDueDate;
    } else if (operation.kind === 'completion' && index >= 0 && canCompleteAssignment(API.getUser(), incoming[index])) {
      operation.task = incoming[index];
      operation.previousCompleted = incoming[index].is_completed;
      incoming[index].is_completed = operation.completed ? 1 : 0;
    } else operation.task = null;
  }
  return incoming;
}
function modalFocusSelector(element) {
  if (element?.id === 'closeModal') return '#closeModal';
  if (!/^\d+$/.test(String(element?.dataset?.id || ''))) return null;
  if (element.classList?.contains('modal-submit-toggle')) return `.modal-submit-toggle[data-id="${element.dataset.id}"]`;
  if (element.classList?.contains('modal-delete')) return `.modal-delete[data-id="${element.dataset.id}"]`;
  if (element.classList?.contains('modal-move-date')) return `.modal-move-date[data-id="${element.dataset.id}"]`;
  if (element.classList?.contains('modal-move-save')) return `.modal-move-save[data-id="${element.dataset.id}"]`;
  return null;
}
function refreshOpenModal() {
  if (modalDate) openModal(modalDate, { allTasks: modalAllTasks, keepFocus: true });
}
function restoreOperationFocus(operation) {
  if (!operation.wasFocused || latestMutationFocus !== operation || !modalDate || modalDate !== operation.modalDate) return;
  const content = document.querySelector('#modal .modal-content');
  const active = document.activeElement;
  if (active !== document.body && active !== content && active !== operation.control) return;
  const replacement = document.querySelector(operation.focusSelector);
  if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
}
function syncCompletionControl(operation) {
  const task = assignments.find(item => Number(item.assignment_id) === operation.id);
  if (!task) return;
  const control = document.querySelector(`.modal-submit-toggle[data-id="${operation.id}"]`)
    || (operation.control?.isConnected !== false ? operation.control : null);
  if (!control) return;
  control.checked = isCompleted(task);
  control.disabled = pendingAssignmentOperations.has(operation.id) || !canCompleteAssignment(API.getUser(), task);
  const row = control.closest('.assignment-item');
  row?.classList.toggle('done', isCompleted(task));
  const meta = row?.querySelector('.meta');
  if (meta) meta.textContent = taskMeta(task, API.getUser());
  const deletion = row?.querySelector('.modal-delete');
  if (deletion) deletion.disabled = pendingAssignmentOperations.has(operation.id);
}
function restoreDeletedTask(operation) {
  if (!operation.task || assignments.some(task => Number(task.assignment_id) === operation.id)) return false;
  const after = assignments.findIndex(task => Number(task.assignment_id) === Number(operation.afterId));
  const before = assignments.findIndex(task => Number(task.assignment_id) === Number(operation.beforeId));
  const index = after >= 0 ? after : before >= 0 ? before + 1 : Math.min(operation.index, assignments.length);
  assignments.splice(index, 0, operation.task);
  return true;
}

API.requireAuth();

async function init() {
  try {
    const cachedUser = API.getUser();
    synchronizeViewScope(cachedUser);
    if (cachedUser) {
      API.loadUserInfo();
      initAdminFilters(cachedUser);
      const endpoint = cachedUser.is_admin ? '/api/assignments' : `/api/users/${cachedUser.id}/assignments`;
      const cached = typeof API.getCachedData === 'function' ? API.getCachedData(endpoint) : null;
      if (Array.isArray(cached)) { assignments = pendingIncomingAssignments(cached); assignmentsLoaded = true; }
      renderCalendar(!assignmentsLoaded);
    }
    const user = await API.ensureUser();
    if (!user) return;
    synchronizeViewScope();
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
  synchronizeViewScope();
  const requestScope = calendarViewScope(user);
  if (!matchesViewScope(requestScope)) return;
  const requestVersion = ++loadVersion;
  const requestMutation = mutationVersion;
  let applied = false;
  assignmentsLoading = true;
  assignmentsError = false;
  renderCalendar();
  try {
    const data = user.is_admin
      ? await API.getAssignments()
      : await API.getUserAssignmentsWithDetails(user.id);
    if (!matchesViewScope(requestScope) || requestVersion !== loadVersion || requestMutation !== mutationVersion) return;
    if (!Array.isArray(data)) throw new Error(data?.error || 'load-failed');
    assignments = pendingIncomingAssignments(data, requestScope);
    assignmentsLoaded = true;
    applied = true;
  } catch {
    if (matchesViewScope(requestScope) && requestVersion === loadVersion) assignmentsError = true;
  } finally {
    if (matchesViewScope(requestScope) && requestVersion === loadVersion) {
      assignmentsLoading = false;
      renderCalendar();
      if (applied) refreshOpenModal();
    }
  }
}

function initAdminFilters(user, resetToDefault = false) {
  if (resetToDefault) {
    const grade = Number(user?.grade);
    const classNumber = Number(user?.class_number);
    const ownClass = user?.is_admin === true && user.can_complete_assignments === true
      && Number.isInteger(grade) && grade >= 1 && grade <= 3
      && Number.isInteger(classNumber) && classNumber >= 1 && classNumber <= 4;
    adminGradeFilter = ownClass ? String(grade) : 'all';
    adminClassFilter = ownClass ? String(classNumber) : 'all';
  }
  document.getElementById('adminCalendarFilter').classList.toggle('show', Boolean(user?.is_admin));
  if (!user?.is_admin) return;
  const grade = document.getElementById('adminGradeFilter');
  const classNumber = document.getElementById('adminClassFilter');
  grade.innerHTML = '<option value="all">전체 학년</option>' + Array.from({ length: 3 }, (_, i) => `<option value="${i + 1}">${i + 1}학년</option>`).join('');
  classNumber.innerHTML = '<option value="all">전체 반</option>' + Array.from({ length: 4 }, (_, i) => `<option value="${i + 1}">${i + 1}반</option>`).join('');
  grade.value = adminGradeFilter;
  classNumber.value = adminClassFilter;
}

function getVisibleAssignments() {
  const user = API.getUser();
  synchronizeViewScope(user);
  if (!user?.is_admin) return assignments;
  return assignments.filter((task) => (adminGradeFilter === 'all' || String(task.target_grade) === adminGradeFilter) && (adminClassFilter === 'all' || task.target_class === null || String(task.target_class) === adminClassFilter));
}
function getMatchingAssignments() {
  return getVisibleAssignments().filter((task) => {
    const stateMatches = taskFilter === 'all' || (canCompleteAssignment(API.getUser(), task) && (taskFilter === 'done' ? isCompleted(task) : !isCompleted(task)));
    return stateMatches && String(task.title || '').toLocaleLowerCase('ko').includes(taskSearch);
  });
}
function urgentDate() {
  const threshold = new Date();
  threshold.setDate(threshold.getDate() + 2);
  return dateString(threshold);
}

function renderCalendar(forceLoading = assignmentsLoading && !assignmentsLoaded) {
  clearCalendarDrag();
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const user = API.getUser();
  synchronizeViewScope(user);
  const visible = getVisibleAssignments();
  const matching = getMatchingAssignments();
  const today = dateString(new Date());
  const threshold = urgentDate();
  document.getElementById('monthTitle').textContent = `${year}년 ${month + 1}월`;
  document.getElementById('classScope').textContent = user?.is_admin
    ? `${adminGradeFilter === 'all' ? '전체 학년' : adminGradeFilter + '학년'} · ${adminClassFilter === 'all' ? '전체 반' : adminClassFilter + '반'} · ${user.can_complete_assignments === true ? '제출 현황은 내 반 기준' : '제출 체크 대상 계정 아님'}`
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
      const title = user?.is_admin ? `${taskScopeLabel(task)} · ${task.title}` : task.title;
      const movable = canMoveAssignment(user, task) && !pendingAssignmentOperations.has(Number(task.assignment_id));
      const saving = pendingAssignmentOperations.get(Number(task.assignment_id))?.kind === 'move';
      return `<span class="task-tag ${cls}${saving ? ' saving' : ''}" data-move-id="${Number(task.assignment_id)}" draggable="${movable}" title="${API.escapeHTML(title + (saving ? ' · 저장 중' : movable ? ' · 드래그해서 날짜 변경' : ''))}"${saving ? ' aria-busy="true"' : ''}>${API.escapeHTML(title)}</span>`;
    }).join('');
    const label = `${month + 1}월 ${d}일${date === today ? ', 오늘' : ''}, 과제 ${tasks.length}개`;
    html += `<button type="button" class="day${date === today ? ' today' : ''}" data-date="${date}" aria-label="${label}"${date === today ? ' aria-current="date"' : ''}><span class="date">${d}</span>${tags}${tasks.length > 2 ? `<span class="task-more">+${tasks.length - 2}개 더</span>` : ''}</button>`;
  }
  html += '<div class="day empty" aria-hidden="true"></div>'.repeat((7 - (firstDay + lastDate) % 7) % 7);
  document.getElementById('calendarBody').innerHTML = html;
  updateOverview(visible, forceLoading);
}

function updateOverview(visibleAssignments, loading) {
  const user = API.getUser();
  const canComplete = user?.can_complete_assignments === true;
  const visible = canComplete ? visibleAssignments.filter(task => canCompleteAssignment(user, task)) : visibleAssignments;
  document.getElementById('urgentLabel').textContent = !canComplete ? '조회 범위 마감 임박' : user?.is_admin ? '내 반 마감 임박' : '마감 임박';
  document.getElementById('normalLabel').textContent = !canComplete ? '조회 범위 진행 중' : user?.is_admin ? '내 반 진행 중' : '진행 중';
  document.getElementById('doneLabel').textContent = !canComplete ? '개인 완료 대상 없음' : user?.is_admin ? '내 제출 완료' : '제출 완료';
  const pending = visible.filter((task) => !isCompleted(task));
  const completed = visible.length - pending.length;
  const urgent = pending.filter((task) => task.due_date <= urgentDate()).length;
  for (const [id, count] of [['urgentCount', urgent], ['normalCount', pending.length - urgent], ['doneCount', completed]]) {
    document.getElementById(id).textContent = loading || (!canComplete && id === 'doneCount') ? '—' : count;
  }
  document.getElementById('upcomingCount').textContent = loading ? '—' : `${pending.length}개`;
  const list = document.getElementById('upcomingList');
  if (loading) list.innerHTML = '<div class="empty-state">과제를 불러오는 중입니다…</div>';
  else if (assignmentsError && visible.length === 0) list.innerHTML = '<div class="empty-state">잠시 후 다시 시도해주세요.</div>';
  else if (pending.length === 0) list.innerHTML = `<div class="empty-state">${!canComplete ? '이 조회 범위에 등록된 과제가 없어요.' : visible.length ? '모든 과제를 제출했어요!<br>잠깐 쉬어가도 좋아요.' : visibleAssignments.length ? '이 조회 범위에 내 반 과제가 없어요.' : '아직 등록된 과제가 없어요.<br>새 과제를 등록해보세요.'}</div>`;
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
  document.getElementById('progressPercent').textContent = loading || !canComplete ? '—' : `${percentage}%`;
  document.getElementById('progressCount').textContent = loading ? '불러오는 중' : !canComplete ? '개인 제출 대상 없음' : `${completed} / ${visible.length}개 완료`;
  document.getElementById('progressBar').style.width = `${percentage}%`;
  document.getElementById('assignmentProgress').setAttribute('aria-valuenow', String(percentage));
  document.getElementById('progressDescription').textContent = !canComplete ? '이 계정은 제출 체크를 사용하지 않습니다.'
    : `${user?.is_admin ? '내 반 기준 · ' : ''}${pending.length ? `미제출 과제가 ${pending.length}개 남아 있어요.` : visible.length ? '모든 과제를 제출했어요.' : '제출 체크할 내 반 과제가 없습니다.'}`;
}

function dateMoveControl(task, user) {
  if (!canMoveAssignment(user, task)) return '';
  const id = Number(task.assignment_id);
  const disabled = pendingAssignmentOperations.has(id) ? ' disabled' : '';
  const value = assignmentDateDrafts.get(id)?.value ?? task.due_date;
  return `<form class="modal-move-form" data-id="${id}"><label for="move-date-${id}">마감일</label><input id="move-date-${id}" class="modal-move-date" data-id="${id}" type="date" min="1000-01-01" max="9999-12-31" value="${API.escapeHTML(value)}" required${disabled}><button class="btn btn-secondary btn-sm modal-move-save" data-id="${id}" type="submit"${disabled}>날짜 변경</button></form>`;
}
function openModal(date, { allTasks = false, keepFocus = false } = {}) {
  const focusedSelector = keepFocus ? modalFocusSelector(document.activeElement) : null;
  modalDate = date;
  modalAllTasks = allTasks;
  if (!keepFocus) previousFocus = document.activeElement;
  const tasks = (allTasks ? getVisibleAssignments() : getMatchingAssignments()).filter((task) => task.due_date === date);
  const user = API.getUser();
  const [year, month, day] = date.split('-').map(Number);
  document.getElementById('modalTitle').textContent = `${year}년 ${month}월 ${day}일 과제`;
  document.getElementById('taskList').innerHTML = tasks.length ? tasks.map((task) => `<div class="assignment-item${isCompleted(task) ? ' done' : ''}"><div class="info"><div class="title">${API.escapeHTML(task.title)}</div>${task.content ? `<div class="detail">${API.renderTextWithLinks(task.content)}</div>` : ''}<div class="meta">${API.escapeHTML(taskMeta(task, user))}</div>${dateMoveControl(task, user)}</div><div class="actions">${canCompleteAssignment(user, task) ? `<label class="submit-check"><input type="checkbox" class="modal-submit-toggle" data-id="${Number(task.assignment_id)}" ${isCompleted(task) ? 'checked' : ''} ${pendingAssignmentOperations.has(Number(task.assignment_id)) ? 'disabled aria-busy="true"' : ''}><span>${user?.is_admin ? '내 제출 완료' : '제출 완료'}</span></label>` : ''}${canDeleteAssignment(user, task) ? `<button type="button" class="btn btn-danger btn-sm modal-delete" data-id="${Number(task.assignment_id)}" ${pendingAssignmentOperations.has(Number(task.assignment_id)) ? 'disabled' : ''}>삭제</button>` : ''}</div></div>`).join('') : '<div class="empty-state">이 날짜에 표시할 과제가 없어요.<br>필터를 확인하거나 새 과제를 등록해보세요.</div><a class="btn btn-primary" href="register.html">새 과제 등록</a>';
  document.getElementById('modal').classList.add('show');
  document.body.classList.add('modal-open');
  const focusedReplacement = focusedSelector && document.querySelector(focusedSelector);
  if (focusedReplacement && !focusedReplacement.disabled) focusedReplacement.focus({ preventScroll: true });
  else if (!keepFocus || !document.getElementById('modal').contains(document.activeElement)) document.querySelector('#modal .modal-content').focus();
}
function closeModal() {
  document.getElementById('modal').classList.remove('show');
  document.body.classList.remove('modal-open');
  modalDate = null;
  if (previousFocus?.isConnected) previousFocus.focus();
  else document.getElementById('todayMonth').focus();
}

async function moveAssignmentDate(id, nextDueDate, expectedDate) {
  synchronizeViewScope();
  id = Number(id);
  const task = assignments.find(item => Number(item.assignment_id) === id);
  if (!Number.isSafeInteger(id) || id < 1 || !canMoveAssignment(API.getUser(), task)
    || pendingAssignmentOperations.has(id) || !validAssignmentDate(nextDueDate) || nextDueDate === task.due_date) return false;
  if (expectedDate !== undefined && expectedDate !== task.due_date) {
    assignmentDateDrafts.delete(id);
    refreshOpenModal();
    AppUI.toast('과제 날짜가 변경되었습니다. 최신 날짜에서 다시 옮겨주세요.', true);
    return false;
  }
  const control = document.activeElement;
  const operation = { kind: 'move', id, task, previousDueDate: task.due_date, nextDueDate,
    viewScope: localViewScope, userId: String(API.getUser().id), generation: assignmentGeneration,
    control, wasFocused: Boolean(modalFocusSelector(control)), focusSelector: modalFocusSelector(control),
    followModal: modalDate === task.due_date, modalDate: nextDueDate };
  const expectedDueDate = task.due_date;
  assignmentDateDrafts.delete(id);
  pendingAssignmentOperations.set(id, operation);
  if (operation.wasFocused) latestMutationFocus = operation;
  mutationVersion++;
  task.due_date = nextDueDate;
  if (operation.followModal) modalDate = nextDueDate;
  renderCalendar(); refreshOpenModal();
  AppUI.toast('마감일을 옮겼어요. 저장 중입니다.');
  try {
    const result = await API.moveAssignment(id, nextDueDate, expectedDueDate);
    if (!currentOperation(operation)) return false;
    if (result?.status === 409 && result.code === 'ASSIGNMENT_DATE_CONFLICT' && validAssignmentDate(result.due_date)) {
      operation.task.due_date = result.due_date;
      if (operation.followModal && modalDate === nextDueDate) modalDate = operation.modalDate = result.due_date;
      AppUI.toast('다른 곳에서 마감일이 변경되어 최신 날짜를 표시했어요. 다시 확인해주세요.', true);
      return false;
    }
    if (!result?.success) throw new Error(result?.error || '마감일을 저장하지 못했습니다.');
    AppUI.toast('마감일이 변경되었습니다.');
    API.refreshNotifications().catch(() => {});
    return true;
  } catch (error) {
    if (currentOperation(operation) && operation.task) {
      operation.task.due_date = operation.previousDueDate;
      if (operation.followModal && modalDate === nextDueDate) modalDate = operation.modalDate = operation.previousDueDate;
      AppUI.toast(`${error.message || '마감일을 저장하지 못했습니다.'} 이전 날짜로 되돌렸어요.`, true);
    }
    return false;
  } finally {
    if (matchesViewScope(operation.viewScope) && pendingAssignmentOperations.get(id) === operation) {
      pendingAssignmentOperations.delete(id); mutationVersion++;
      if (typeof API.invalidateDataCache === 'function') API.invalidateDataCache();
      renderCalendar(); refreshOpenModal(); restoreOperationFocus(operation);
    }
  }
}

function clearCalendarDrag() {
  calendarDragPreview?.remove();
  calendarDragPreview = null;
  dragOverDay?.classList.remove('drop-target');
  dragOverDay = null;
  draggedAssignment = null;
  document.getElementById('calendarBody').classList.remove('is-dragging');
}
function setCalendarDragPreview(task, dataTransfer) {
  if (typeof dataTransfer.setDragImage !== 'function') return;
  const preview = document.createElement('div');
  preview.className = 'calendar-drag-preview';
  preview.textContent = String(task.title || '과제');
  preview.setAttribute('aria-hidden', 'true');
  document.body.appendChild(preview);
  calendarDragPreview = preview;
  try {
    // A separate rendered element avoids clipping the native preview to the
    // small calendar tag or inheriting its surrounding date button.
    preview.getBoundingClientRect();
    dataTransfer.setDragImage(preview, 12, 18);
  } catch {
    preview.remove();
    calendarDragPreview = null;
  }
}
function activeDraggedTask() {
  const drag = draggedAssignment;
  if (!drag || !matchesViewScope(drag.viewScope)) return null;
  const task = assignments.find(item => Number(item.assignment_id) === drag.id);
  return canMoveAssignment(API.getUser(), task) && !pendingAssignmentOperations.has(drag.id) && task.due_date === drag.dueDate ? task : null;
}
document.getElementById('calendarBody').addEventListener('dragstart', (event) => {
  synchronizeViewScope();
  clearCalendarDrag();
  const tag = event.target.closest('[data-move-id]');
  const id = Number(tag?.dataset.moveId);
  const task = assignments.find(item => Number(item.assignment_id) === id);
  if (!tag || !event.dataTransfer || !canMoveAssignment(API.getUser(), task) || pendingAssignmentOperations.has(id)) {
    event.preventDefault(); return;
  }
  draggedAssignment = { id, dueDate: task.due_date, viewScope: localViewScope };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(id));
  document.getElementById('calendarBody').classList.add('is-dragging');
  setCalendarDragPreview(task, event.dataTransfer);
});
document.getElementById('calendarBody').addEventListener('dragover', (event) => {
  if (!activeDraggedTask()) return;
  const day = event.target.closest('[data-date]');
  if (!day || !validAssignmentDate(day.dataset.date)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  if (dragOverDay !== day) {
    dragOverDay?.classList.remove('drop-target');
    dragOverDay = day;
    day.classList.add('drop-target');
  }
});
document.getElementById('calendarBody').addEventListener('dragleave', (event) => {
  if (dragOverDay && !dragOverDay.contains(event.relatedTarget)) {
    dragOverDay.classList.remove('drop-target'); dragOverDay = null;
  }
});
document.getElementById('calendarBody').addEventListener('drop', (event) => {
  const task = activeDraggedTask();
  const day = event.target.closest('[data-date]');
  const drag = draggedAssignment;
  clearCalendarDrag();
  if (!task || !day) return;
  event.preventDefault();
  suppressCalendarClickUntil = Date.now() + 300;
  void moveAssignmentDate(drag.id, day.dataset.date, drag.dueDate);
});
document.getElementById('calendarBody').addEventListener('dragend', () => {
  clearCalendarDrag();
  suppressCalendarClickUntil = Date.now() + 300;
});
document.getElementById('calendarBody').addEventListener('click', (event) => {
  if (Date.now() < suppressCalendarClickUntil) { event.preventDefault(); return; }
  const day = event.target.closest('[data-date]');
  if (day && (!assignmentsLoading || assignmentsLoaded)) openModal(day.dataset.date);
});
document.getElementById('upcomingList').addEventListener('click', (event) => {
  const item = event.target.closest('[data-date]');
  if (item) openModal(item.dataset.date, { allTasks: true });
});
document.getElementById('taskList').addEventListener('submit', (event) => {
  const form = event.target.closest('.modal-move-form');
  if (!form) return;
  event.preventDefault();
  void moveAssignmentDate(form.dataset.id, form.querySelector('.modal-move-date').value, assignmentDateDrafts.get(Number(form.dataset.id))?.previousDueDate);
});
document.getElementById('taskList').addEventListener('input', (event) => {
  synchronizeViewScope();
  const input = event.target.closest('.modal-move-date');
  if (!input) return;
  const id = Number(input.dataset.id);
  const task = assignments.find(item => Number(item.assignment_id) === id);
  if (canMoveAssignment(API.getUser(), task) && !pendingAssignmentOperations.has(id)) {
    assignmentDateDrafts.set(id, { value: input.value, previousDueDate: task.due_date });
  }
});
document.getElementById('taskList').addEventListener('click', async (event) => {
  const button = event.target.closest('.modal-delete');
  if (!button || button.disabled) return;
  const id = Number(button.dataset.id);
  const index = assignments.findIndex(task => Number(task.assignment_id) === id);
  const task = assignments[index];
  if (!id || pendingAssignmentOperations.has(id) || !canDeleteAssignment(API.getUser(), task)
    || !confirm('이 과제를 삭제할까요? 삭제하면 되돌릴 수 없습니다.')) return;
  const operation = { kind: 'delete', id, task, index, beforeId: assignments[index - 1]?.assignment_id, afterId: assignments[index + 1]?.assignment_id,
    viewScope: localViewScope, userId: String(API.getUser().id), generation: assignmentGeneration, control: button, wasFocused: document.activeElement === button,
    modalDate, focusSelector: `.modal-delete[data-id="${id}"]` };
  pendingAssignmentOperations.set(id, operation);
  if (operation.wasFocused) latestMutationFocus = operation;
  mutationVersion++;
  button.disabled = true;
  assignments.splice(index, 1);
  renderCalendar(); refreshOpenModal();
  AppUI.toast('과제를 화면에서 삭제했어요. 저장 중입니다.');
  try {
    const result = await API.deleteAssignment(id);
    if (!result?.success) throw new Error(result?.error || '과제를 삭제하지 못했습니다.');
    if (currentOperation(operation)) {
      AppUI.toast('과제가 삭제되었습니다.');
      API.refreshNotifications().catch(() => {});
    }
  } catch (error) {
    if (currentOperation(operation)) {
      const restored = restoreDeletedTask(operation);
      AppUI.toast(`${error.message || '삭제하지 못했습니다.'} ${restored ? '과제를 다시 표시했어요.' : '최신 목록을 유지합니다.'}`, true);
    }
  } finally {
    if (matchesViewScope(operation.viewScope) && pendingAssignmentOperations.get(id) === operation) {
      pendingAssignmentOperations.delete(id); mutationVersion++;
      button.disabled = false;
      renderCalendar(); refreshOpenModal(); restoreOperationFocus(operation);
    }
  }
});
document.getElementById('taskList').addEventListener('change', async (event) => {
  const checkbox = event.target.closest('.modal-submit-toggle');
  if (!checkbox) return;
  const id = Number(checkbox.dataset.id);
  const task = assignments.find((item) => Number(item.assignment_id) === id);
  if (pendingAssignmentOperations.has(id)) { checkbox.checked = Boolean(task && isCompleted(task)); checkbox.disabled = true; return; }
  if (checkbox.disabled) return;
  if (!canCompleteAssignment(API.getUser(), task)) {
    checkbox.checked = false;
    checkbox.disabled = true;
    AppUI.toast('소속 반의 학생 계정만 제출 상태를 변경할 수 있습니다.', true);
    return;
  }
  const completed = checkbox.checked;
  const operation = { kind: 'completion', id, task, completed, previousCompleted: task.is_completed,
    viewScope: localViewScope, userId: String(API.getUser().id), generation: assignmentGeneration, control: checkbox, wasFocused: document.activeElement === checkbox,
    modalDate, focusSelector: `.modal-submit-toggle[data-id="${id}"]` };
  pendingAssignmentOperations.set(id, operation);
  if (operation.wasFocused) latestMutationFocus = operation;
  mutationVersion++;
  task.is_completed = completed ? 1 : 0;
  checkbox.disabled = true;
  renderCalendar(); syncCompletionControl(operation);
  AppUI.toast('제출 상태를 변경했어요. 저장 중입니다.');
  try {
    const result = await API.toggleAssignment(id, completed);
    if (!result?.success) throw new Error(result?.error || '제출 상태를 저장하지 못했습니다.');
    if (currentOperation(operation)) AppUI.toast(completed ? '제출 완료로 저장했어요.' : '미제출로 저장했어요.');
  } catch (error) {
    if (currentOperation(operation) && operation.task) {
      operation.task.is_completed = operation.previousCompleted;
      AppUI.toast(`${error.message || '상태를 저장하지 못했습니다.'} 이전 제출 상태로 되돌렸어요.`, true);
    }
  } finally {
    if (matchesViewScope(operation.viewScope) && pendingAssignmentOperations.get(id) === operation) {
      pendingAssignmentOperations.delete(id); mutationVersion++;
      renderCalendar(); syncCompletionControl(operation); restoreOperationFocus(operation);
    }
  }
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
