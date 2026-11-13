const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function classes() {
  const values = new Set();
  return { add: value => values.add(value), remove: value => values.delete(value), contains: value => values.has(value), toggle(value, force) { const on = force === undefined ? !values.has(value) : force; if (on) values.add(value); else values.delete(value); return on; } };
}
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const day = localDate();
const fixtures = () => [
  { assignment_id: 1, title: '내 반 과제', target_grade: 1, target_class: 2, due_date: day, is_completed: 0, creator_name: '선생님' },
  { assignment_id: 2, title: '학년 공통 과제', target_grade: 1, target_class: null, due_date: day, is_completed: 1, creator_name: '선생님' },
  { assignment_id: 3, title: '다른 반 과제', target_grade: 1, target_class: 3, due_date: day, is_completed: 1, creator_name: '선생님' },
  { assignment_id: 4, title: '다른 학년 과제', target_grade: 2, target_class: 2, due_date: day, is_completed: 1, creator_name: '선생님' }
];

async function calendar(user, data = fixtures(), options = {}) {
  const nodes = new Map(), listeners = new Map(), writes = [], toasts = [], reads = [];
  const cachedReads = [];
  const controls = new Map();
  let document;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { classList: classes(), style: {}, dataset: {}, innerHTML: '', textContent: '', value: '',
      addEventListener: (kind, handler) => listeners.set(id + ':' + kind, handler), setAttribute() {}, focus() { if (document) document.activeElement = this; }, contains: () => false });
    return nodes.get(id);
  };
  const filterButtons = ['all', 'pending', 'done'].map(value => ({ dataset: { taskFilter: value }, classList: classes(), setAttribute() {}, addEventListener() {} }));
  document = { getElementById: node, querySelectorAll: () => filterButtons, querySelector: selector => selector === '#modal .modal-content' ? node('modal-content') : controls.get(selector) || null, body: { classList: classes() }, activeElement: node('prior-focus'), addEventListener() {} };
  const API = {
    requireAuth() {}, getUser: () => user, ensureUser: async () => null, loadUserInfo() {},
    escapeHTML: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    renderTextWithLinks: value => String(value),
    getAssignments: async () => { reads.push('admin'); return data; },
    getUserAssignmentsWithDetails: async () => { reads.push('student'); return data; },
    toggleAssignment: async (id, completed) => { writes.push({ id, completed }); return { success: true }; },
    deleteAssignment: async () => ({ success: true }),
    refreshNotifications: async () => {}
  };
  if (options.cached) API.getCachedData = endpoint => { cachedReads.push(endpoint); return options.cached; };
  if (options.ensureUser) API.ensureUser = options.ensureUser;
  const context = vm.createContext({ API, document, AppUI: { localDate, toast: (message, error) => toasts.push({ message, error }) }, Date, confirm: () => true, window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/calendar.js'), 'utf8'), context);
  await new Promise(setImmediate);
  if (!options.skipLoad) await vm.runInContext('loadAssignments()', context);
  return { context, document, controls, nodes, listeners, writes, reads, cachedReads, toasts, API, data, run: code => vm.runInContext(code, context) };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function rowControls(app, id, checked = true) {
  const meta = { textContent: '' };
  const row = { classList: classes(), querySelector: selector => selector === '.meta' ? meta : selector === '.modal-delete' ? deletion : null };
  const checkbox = { checked, disabled: false, isConnected: true, dataset: { id: String(id) }, classList: classes(),
    closest: selector => selector === '.modal-submit-toggle' ? checkbox : row, focus() { app.document.activeElement = this; } };
  checkbox.classList.add('modal-submit-toggle');
  const deletion = { disabled: false, isConnected: true, dataset: { id: String(id) }, classList: classes(),
    closest: selector => selector === '.modal-delete' ? deletion : row, focus() { app.document.activeElement = this; } };
  deletion.classList.add('modal-delete');
  app.controls.set(`.modal-submit-toggle[data-id="${id}"]`, checkbox);
  app.controls.set(`.modal-delete[data-id="${id}"]`, deletion);
  return { checkbox, deletion, meta, row };
}

test('student and student-admin completion permission is confined to their own class and grade-wide tasks', async () => {
  for (const is_admin of [false, true]) {
    const app = await calendar({ id: 11, is_admin, can_complete_assignments: true, grade: 1, class_number: 2 });
    assert.equal(app.run('canCompleteAssignment(API.getUser(), assignments[0])'), true);
    assert.equal(app.run('canCompleteAssignment(API.getUser(), assignments[1])'), true);
    assert.equal(app.run('canCompleteAssignment(API.getUser(), assignments[2])'), false);
    assert.equal(app.run('canCompleteAssignment(API.getUser(), assignments[3])'), false);
    if (is_admin) app.run("adminGradeFilter = 'all'; adminClassFilter = 'all'");
    app.run(`openModal('${day}')`);
    const html = app.nodes.get('taskList').innerHTML;
    assert.match(html, /modal-submit-toggle" data-id="1"/);
    assert.match(html, /modal-submit-toggle" data-id="2"/);
    assert.ok(!/modal-submit-toggle" data-id="[34]"/.test(html));
    assert.ok(html.includes('열람 전용'));
    assert.equal(app.reads[0], is_admin ? 'admin' : 'student');
  }
});

test('teacher or missing completion privilege never exposes personal completion controls', async () => {
  for (const flag of [false, undefined, 'true', 1]) {
    const app = await calendar({ id: 12, is_admin: true, can_complete_assignments: flag, grade: 1, class_number: 2 });
    app.run(`openModal('${day}')`);
    assert.ok(!app.nodes.get('taskList').innerHTML.includes('modal-submit-toggle'));
    assert.equal(app.nodes.get('progressPercent').textContent, '—');
    assert.match(app.nodes.get('progressDescription').textContent, /사용하지 않습니다/);
    assert.equal(app.nodes.get('adminGradeFilter').value, 'all');
    assert.equal(app.nodes.get('adminClassFilter').value, 'all');
  }
});

test('teacher read-only overview retains all visible deadlines and upcoming tasks without a personal completed count', async () => {
  const app = await calendar({ id: 12, is_admin: true, can_complete_assignments: false, grade: 1, class_number: 2 });
  assert.equal(app.nodes.get('urgentCount').textContent, 4);
  assert.equal(app.nodes.get('normalCount').textContent, 0);
  assert.equal(app.nodes.get('upcomingCount').textContent, '4개');
  assert.equal(app.nodes.get('doneCount').textContent, '—');
  assert.equal(app.nodes.get('progressPercent').textContent, '—');
  assert.match(app.nodes.get('urgentLabel').textContent, /조회 범위/);
  assert.ok(app.nodes.get('upcomingList').innerHTML.includes('다른 반 과제'));
  assert.ok(app.nodes.get('upcomingList').innerHTML.includes('다른 학년 과제'));
  app.run(`openModal('${day}')`);
  const html = app.nodes.get('taskList').innerHTML;
  assert.equal((html.match(/열람 전용/g) || []).length, 4);
  assert.ok(!html.includes('modal-submit-toggle'));
});

test('admin personal progress and completion filters exclude other classes even if their payload contains a completion flag', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 });
  assert.equal(app.nodes.get('doneCount').textContent, 1);
  assert.equal(app.nodes.get('progressCount').textContent, '1 / 2개 완료');
  assert.equal(app.nodes.get('progressPercent').textContent, '50%');
  assert.match(app.nodes.get('classScope').textContent, /내 반 기준/);
  assert.match(app.nodes.get('doneLabel').textContent, /내 제출/);
  app.run(`openModal('${day}')`);
  assert.ok(app.nodes.get('taskList').innerHTML.includes('1학년 전체'));
  assert.ok(!app.nodes.get('taskList').innerHTML.includes('null반'));
  assert.deepEqual(Array.from(app.run("taskFilter = 'done'; getMatchingAssignments().map(task => task.assignment_id)")), [2]);
  assert.deepEqual(Array.from(app.run("taskFilter = 'pending'; getMatchingAssignments().map(task => task.assignment_id)")), [1]);
  assert.deepEqual(Array.from(app.run("taskFilter = 'all'; getMatchingAssignments().map(task => task.assignment_id)")), [1, 2]);
  app.run("adminGradeFilter = '2'; adminClassFilter = '2'; renderCalendar()");
  assert.equal(app.nodes.get('progressCount').textContent, '0 / 0개 완료');
  assert.match(app.nodes.get('upcomingList').innerHTML, /내 반 과제가 없어요/);
});

test('admin class filters retain grade-wide assignments that also apply to the selected class', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 });
  assert.deepEqual(Array.from(app.run("adminGradeFilter = '1'; adminClassFilter = '2'; getVisibleAssignments().map(task => task.assignment_id)")), [1, 2]);
  assert.deepEqual(Array.from(app.run("adminClassFilter = '3'; getVisibleAssignments().map(task => task.assignment_id)")), [2, 3]);
  assert.deepEqual(Array.from(app.run("taskFilter = 'done'; getMatchingAssignments().map(task => task.assignment_id)")), [2]);
});

test('student admins initially see their own class and grade-wide tasks, including cached first paint', async () => {
  const identity = deferred();
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: '1', class_number: '2' }, fixtures(), { cached: fixtures(), ensureUser: () => identity.promise, skipLoad: true });
  assert.equal(app.nodes.get('adminGradeFilter').value, '1');
  assert.equal(app.nodes.get('adminClassFilter').value, '2');
  assert.deepEqual(Array.from(app.run('getVisibleAssignments().map(task => task.assignment_id)')), [1, 2]);
  const html = app.nodes.get('calendarBody').innerHTML;
  assert.ok(html.includes('내 반 과제'));
  assert.ok(html.includes('학년 공통 과제'));
  assert.ok(!html.includes('다른 반 과제'));
  assert.ok(!html.includes('다른 학년 과제'));
  identity.resolve(null);
});

test('student admins can switch to other classes or all and a same-user refresh preserves that choice', async () => {
  const user = { id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 };
  const app = await calendar(user);
  app.listeners.get('adminClassFilter:change')({ target: { value: '3' } });
  assert.deepEqual(Array.from(app.run('getVisibleAssignments().map(task => task.assignment_id)')), [2, 3]);
  app.run('initAdminFilters(API.getUser())');
  await app.run('loadAssignments()');
  assert.equal(app.nodes.get('adminClassFilter').value, '3');
  assert.deepEqual(Array.from(app.run('getVisibleAssignments().map(task => task.assignment_id)')), [2, 3]);
  app.listeners.get('adminGradeFilter:change')({ target: { value: 'all' } });
  assert.equal(app.nodes.get('adminClassFilter').value, 'all');
  assert.deepEqual(Array.from(app.run('getVisibleAssignments().map(task => task.assignment_id)')), [1, 2, 3, 4]);
});

test('account, class and role changes reset the default without carrying a previous admin filter', async () => {
  const user = { id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 };
  const app = await calendar(user);
  app.run("adminGradeFilter = 'all'; adminClassFilter = 'all'");
  Object.assign(user, { id: 20, grade: 2, class_number: 3 });
  await app.run('loadAssignments()');
  assert.equal(app.nodes.get('adminGradeFilter').value, '2');
  assert.equal(app.nodes.get('adminClassFilter').value, '3');
  user.can_complete_assignments = false;
  await app.run('loadAssignments()');
  assert.equal(app.nodes.get('adminGradeFilter').value, 'all');
  assert.equal(app.nodes.get('adminClassFilter').value, 'all');
  user.is_admin = false;
  await app.run('loadAssignments()');
  assert.equal(app.nodes.get('adminCalendarFilter').classList.contains('show'), false);
});

test('student-admin checkbox saves their own completion and keeps the class in updated metadata', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 });
  const meta = { textContent: '' };
  const item = { classList: classes(), querySelector: () => meta };
  const checkbox = { checked: true, disabled: false, dataset: { id: '1' }, closest: selector => selector === '.modal-submit-toggle' ? checkbox : item };
  await app.listeners.get('taskList:change')({ target: checkbox });
  assert.deepEqual(app.writes, [{ id: 1, completed: true }]);
  assert.equal(app.run('assignments[0].is_completed'), 1);
  assert.equal(checkbox.disabled, false);
  assert.match(meta.textContent, /1학년 2반/);
  assert.match(meta.textContent, /제출 완료/);
});

test('an injected foreign-class checkbox is rejected before any completion API request', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 });
  for (const id of ['3', '999']) {
    const checkbox = { checked: true, disabled: false, dataset: { id }, closest: () => checkbox };
    await app.listeners.get('taskList:change')({ target: checkbox });
    assert.equal(checkbox.checked, false);
    assert.equal(checkbox.disabled, true);
  }
  assert.equal(app.writes.length, 0);
  assert.ok(app.toasts.every(toast => toast.error === true));
});

test('a failed own-class completion save restores the checkbox without changing local completion state', async () => {
  const app = await calendar({ id: 11, is_admin: false, can_complete_assignments: true, grade: 1, class_number: 2 });
  app.API.toggleAssignment = async () => ({ success: false, error: '저장 실패' });
  const row = { classList: classes(), querySelector: () => ({ textContent: '' }) };
  const checkbox = { checked: true, disabled: false, dataset: { id: '1' }, closest: selector => selector === '.modal-submit-toggle' ? checkbox : row };
  await app.listeners.get('taskList:change')({ target: checkbox });
  assert.equal(checkbox.checked, false);
  assert.equal(checkbox.disabled, false);
  assert.equal(app.data[0].is_completed, 0);
  assert.match(app.toasts.at(-1).message, /저장 실패/);
});

test('completion changes checkbox, metadata and counts before the server resolves and only its row is busy', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 });
  app.run(`openModal('${day}')`);
  const own = rowControls(app, 1);
  const other = rowControls(app, 2);
  const response = deferred();
  let calls = 0;
  app.API.toggleAssignment = () => { calls++; return response.promise; };
  app.document.activeElement = own.checkbox;
  const saving = app.listeners.get('taskList:change')({ target: own.checkbox });
  assert.equal(app.run('assignments.find(task => task.assignment_id === 1).is_completed'), 1);
  assert.equal(app.nodes.get('doneCount').textContent, 2);
  assert.match(own.meta.textContent, /제출 완료/);
  assert.equal(own.row.classList.contains('done'), true);
  assert.equal(own.checkbox.disabled, true);
  assert.equal(own.deletion.disabled, true);
  assert.equal(other.checkbox.disabled, false);
  assert.match(app.toasts.at(-1).message, /저장 중/);
  own.checkbox.checked = false;
  await app.listeners.get('taskList:change')({ target: own.checkbox });
  assert.equal(calls, 1);
  assert.equal(own.checkbox.checked, true);
  response.resolve({ success: true });
  await saving;
  assert.equal(own.checkbox.disabled, false);
  assert.equal(own.deletion.disabled, false);
  assert.equal(app.nodes.get('doneCount').textContent, 2);
  assert.equal(app.run('pendingAssignmentOperations.size'), 0);
});

test('a failed optimistic completion rolls back only that assignment after a different assignment succeeds', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 });
  const one = rowControls(app, 1, true), two = rowControls(app, 2, false);
  const first = deferred(), second = deferred();
  app.API.toggleAssignment = id => id === 1 ? first.promise : second.promise;
  const savingOne = app.listeners.get('taskList:change')({ target: one.checkbox });
  const savingTwo = app.listeners.get('taskList:change')({ target: two.checkbox });
  assert.deepEqual(Array.from(app.run('assignments.slice(0, 2).map(task => task.is_completed)')), [1, 0]);
  second.resolve({ success: true });
  await savingTwo;
  first.resolve({ success: false, error: '연결 실패' });
  await savingOne;
  assert.deepEqual(Array.from(app.run('assignments.slice(0, 2).map(task => task.is_completed)')), [0, 0]);
  assert.equal(one.checkbox.checked, false);
  assert.equal(two.checkbox.checked, false);
  assert.equal(app.nodes.get('doneCount').textContent, 0);
  assert.match(app.toasts.at(-1).message, /되돌렸어요/);
});

test('reload overlays a pending completion and its later failure rolls back the current loaded task object', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 });
  app.run(`openModal('${day}')`);
  const control = rowControls(app, 1);
  const response = deferred();
  app.API.toggleAssignment = () => response.promise;
  const saving = app.listeners.get('taskList:change')({ target: control.checkbox });
  await app.run('loadAssignments()');
  assert.equal(app.run('assignments[0].is_completed'), 1);
  assert.equal(app.data[0].is_completed, 0, 'optimistic edits must not mutate the raw GET/cache payload');
  assert.match(app.nodes.get('taskList').innerHTML, /data-id="1" checked disabled/);
  response.resolve({ success: false, error: '저장 실패' });
  await saving;
  assert.equal(app.run('assignments[0].is_completed'), 0);
  assert.equal(control.checkbox.checked, false);
  assert.equal(control.checkbox.disabled, false);
});

test('a completion rollback restores the replacement modal control and its focus after a rerender', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 });
  app.run(`openModal('${day}')`);
  const first = rowControls(app, 1), response = deferred();
  app.API.toggleAssignment = () => response.promise;
  app.document.activeElement = first.checkbox;
  const saving = app.listeners.get('taskList:change')({ target: first.checkbox });
  first.checkbox.isConnected = false;
  const replacement = rowControls(app, 1);
  app.document.activeElement = app.nodes.get('modal-content');
  response.resolve({ success: false, error: '저장 실패' });
  await saving;
  assert.equal(replacement.checkbox.checked, false);
  assert.equal(replacement.checkbox.disabled, false);
  assert.equal(app.document.activeElement, replacement.checkbox);
});

test('a read started before a completion cannot replace the optimistic or newly confirmed value', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 });
  const read = deferred(), write = deferred();
  app.API.getAssignments = () => read.promise;
  app.API.toggleAssignment = () => write.promise;
  const reloading = app.run('loadAssignments()');
  const own = rowControls(app, 1);
  const saving = app.listeners.get('taskList:change')({ target: own.checkbox });
  write.resolve({ success: true });
  await saving;
  read.resolve(fixtures());
  await reloading;
  assert.equal(app.run('assignments[0].is_completed'), 1);
  assert.equal(app.nodes.get('doneCount').textContent, 2);
});

test('a failed pending completion never recreates a task removed by a newer authoritative load', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 });
  const own = rowControls(app, 1), response = deferred();
  app.API.toggleAssignment = () => response.promise;
  const saving = app.listeners.get('taskList:change')({ target: own.checkbox });
  app.API.getAssignments = async () => fixtures().filter(task => task.assignment_id !== 1);
  await app.run('loadAssignments()');
  response.resolve({ success: false, error: '삭제된 과제' });
  await saving;
  assert.deepEqual(Array.from(app.run('assignments.map(task => task.assignment_id)')), [2, 3, 4]);
});

test('delete removes immediately and a failed delete restores its position without restoring another successful deletion', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 });
  app.run(`openModal('${day}')`);
  const two = rowControls(app, 2), three = rowControls(app, 3);
  const second = deferred(), third = deferred();
  let calls = 0;
  app.API.deleteAssignment = id => { calls++; return id === 2 ? second.promise : third.promise; };
  const removingTwo = app.listeners.get('taskList:click')({ target: two.deletion });
  assert.deepEqual(Array.from(app.run('assignments.map(task => task.assignment_id)')), [1, 3, 4]);
  assert.ok(!app.nodes.get('taskList').innerHTML.includes('data-id="2"'));
  await app.listeners.get('taskList:click')({ target: two.deletion });
  assert.equal(calls, 1);
  const removingThree = app.listeners.get('taskList:click')({ target: three.deletion });
  assert.deepEqual(Array.from(app.run('assignments.map(task => task.assignment_id)')), [1, 4]);
  third.resolve({ success: true });
  await removingThree;
  second.resolve({ success: false, error: '삭제 실패' });
  await removingTwo;
  assert.deepEqual(Array.from(app.run('assignments.map(task => task.assignment_id)')), [1, 2, 4]);
  assert.equal(two.deletion.disabled, false);
  assert.match(app.toasts.at(-1).message, /다시 표시/);
});

test('pending deletion is a reload tombstone and rollback uses the latest server task instead of an old snapshot', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 });
  const two = rowControls(app, 2), response = deferred();
  app.API.deleteAssignment = () => response.promise;
  const removing = app.listeners.get('taskList:click')({ target: two.deletion });
  const latest = fixtures(); latest[1].title = '서버에서 수정된 공통 과제';
  app.API.getAssignments = async () => latest;
  await app.run('loadAssignments()');
  assert.deepEqual(Array.from(app.run('assignments.map(task => task.assignment_id)')), [1, 3, 4]);
  response.resolve({ success: false, error: '삭제 실패' });
  await removing;
  assert.deepEqual(Array.from(app.run('assignments.map(task => task.assignment_id)')), [1, 2, 3, 4]);
  assert.equal(app.run('assignments[1].title'), '서버에서 수정된 공통 과제');
});

test('a failed deletion does not resurrect a task already absent from the newer server snapshot', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 });
  const two = rowControls(app, 2), response = deferred();
  app.API.deleteAssignment = () => response.promise;
  const removing = app.listeners.get('taskList:click')({ target: two.deletion });
  app.API.getAssignments = async () => fixtures().filter(task => task.assignment_id !== 2);
  await app.run('loadAssignments()');
  response.resolve({ success: false, error: '이미 삭제됨' });
  await removing;
  assert.deepEqual(Array.from(app.run('assignments.map(task => task.assignment_id)')), [1, 3, 4]);
});

test('unauthorized deletion does not optimistically remove data or issue a server request', async () => {
  const app = await calendar({ id: 11, is_admin: false, can_complete_assignments: true, grade: 1, class_number: 2 });
  let calls = 0;
  app.API.deleteAssignment = async () => { calls++; return { success: true }; };
  const control = rowControls(app, 3);
  await app.listeners.get('taskList:click')({ target: control.deletion });
  assert.equal(calls, 0);
  assert.equal(app.run('assignments.length'), 4);
});

test('cached assignments are rendered before identity revalidation finishes and remain visible during a fresh read', async () => {
  for (const is_admin of [true, false]) {
    const identity = deferred();
    const app = await calendar({ id: 11, is_admin, can_complete_assignments: true, grade: 1, class_number: 2 }, fixtures(), { cached: fixtures(), ensureUser: () => identity.promise, skipLoad: true });
    assert.deepEqual(app.cachedReads, [is_admin ? '/api/assignments' : '/api/users/11/assignments']);
    assert.equal(app.reads.length, 0);
    assert.equal(app.nodes.get('doneCount').textContent, 1);
    assert.ok(app.nodes.get('calendarBody').innerHTML.includes('내 반 과제'));
    identity.resolve(null);
    const fresh = deferred();
    app.API.getAssignments = app.API.getUserAssignmentsWithDetails = () => fresh.promise;
    const reloading = app.run('loadAssignments()');
    assert.equal(app.nodes.get('doneCount').textContent, 1);
    assert.ok(app.nodes.get('calendarBody').innerHTML.includes('내 반 과제'));
    fresh.resolve(fixtures());
    await reloading;
  }
});

test('late calendar reads and failed writes cannot restore another account or former class data', async () => {
  for (const patch of [{ id: 90 }, { grade: 2, class_number: 3 }, { is_admin: false }]) {
    const user = { id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 };
    const app = await calendar(user);
    const pendingRead = deferred(), pendingWrite = deferred();
    app.API.getAssignments = () => pendingRead.promise;
    const loading = app.run('loadAssignments()');
    const control = rowControls(app, 1);
    app.API.toggleAssignment = () => pendingWrite.promise;
    const writing = app.listeners.get('taskList:change')({ target: control.checkbox });
    Object.assign(user, patch);
    pendingRead.resolve(fixtures()); await loading;
    pendingWrite.resolve({ success: false, error: '늦은 실패' }); await writing;
    assert.equal(app.run('assignments.length'), 0);
    assert.equal(app.run('pendingAssignmentOperations.size'), 0);
    assert.ok(!app.nodes.get('calendarBody').innerHTML.includes('내 반 과제'));
  }
});
