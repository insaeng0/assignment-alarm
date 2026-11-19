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
  const nodes = new Map(), listeners = new Map(), writes = [], moves = [], toasts = [], reads = [];
  const cachedReads = [];
  const controls = new Map();
  const createdElements = [];
  let document;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { classList: classes(), style: {}, dataset: {}, innerHTML: '', textContent: '', value: '',
      addEventListener: (kind, handler) => listeners.set(id + ':' + kind, handler), setAttribute() {}, focus() { if (document) document.activeElement = this; }, contains: () => false });
    return nodes.get(id);
  };
  const filterButtons = ['all', 'pending', 'done'].map(value => ({ dataset: { taskFilter: value }, classList: classes(), setAttribute() {}, addEventListener() {} }));
  const body = { classList: classes(), children: [], appendChild(element) {
    element.remove(); this.children.push(element); element.parentNode = this; element.isConnected = true; return element;
  }, removeChild(element) {
    const index = this.children.indexOf(element);
    if (index < 0) throw new Error('Element is not a child.');
    this.children.splice(index, 1); element.parentNode = null; element.isConnected = false; return element;
  } };
  document = { getElementById: node, querySelectorAll: () => filterButtons, querySelector: selector => selector === '#modal .modal-content' ? node('modal-content') : controls.get(selector) || null,
    body, activeElement: node('prior-focus'), addEventListener() {}, createElement(tagName) {
      const element = { tagName: String(tagName).toUpperCase(), className: '', classList: classes(), style: {}, dataset: {},
        textContent: '', innerHTML: '', attributes: {}, parentNode: null, isConnected: false,
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getBoundingClientRect() { return { x: 0, y: 0, width: 220, height: 48 }; },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); } };
      createdElements.push(element); return element;
    } };
  const API = {
    requireAuth() {}, getUser: () => user, ensureUser: async () => null, loadUserInfo() {},
    escapeHTML: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    renderTextWithLinks: value => String(value),
    getAssignments: async () => { reads.push('admin'); return data; },
    getUserAssignmentsWithDetails: async () => { reads.push('student'); return data; },
    toggleAssignment: async (id, completed) => { writes.push({ id, completed }); return { success: true }; },
    moveAssignment: async (id, dueDate, expectedDueDate) => { moves.push({ id, dueDate, expectedDueDate }); return { success: true, due_date: dueDate }; },
    deleteAssignment: async () => ({ success: true }),
    refreshNotifications: async () => {}
  };
  if (options.cached) API.getCachedData = endpoint => { cachedReads.push(endpoint); return options.cached; };
  if (options.ensureUser) API.ensureUser = options.ensureUser;
  const context = vm.createContext({ API, document, AppUI: { localDate, toast: (message, error) => toasts.push({ message, error }) }, Date, confirm: () => true, window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/calendar.js'), 'utf8'), context);
  await new Promise(setImmediate);
  if (!options.skipLoad) await vm.runInContext('loadAssignments()', context);
  return { context, document, controls, createdElements, nodes, listeners, writes, moves, reads, cachedReads, toasts, API, data, run: code => vm.runInContext(code, context) };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function shiftedDay(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return localDate(date);
}
function moveFixtures() {
  return fixtures().map((task, index) => ({ ...task, created_by: index === 0 || index === 2 ? 11 : 22 }));
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
function modalDateControls(app, id, value = day) {
  const input = { value, disabled: false, isConnected: true, dataset: { id: String(id) }, classList: classes(),
    closest: selector => selector === '.modal-move-date' ? input : selector === '.modal-move-form' ? form : null,
    focus() { app.document.activeElement = this; } };
  const save = { disabled: false, isConnected: true, dataset: { id: String(id) }, classList: classes(),
    closest: selector => selector === '.modal-move-save' ? save : selector === '.modal-move-form' ? form : null,
    focus() { app.document.activeElement = this; } };
  const form = { dataset: { id: String(id) }, querySelector: selector => selector === '.modal-move-date' ? input : null };
  input.classList.add('modal-move-date'); save.classList.add('modal-move-save');
  app.controls.set(`.modal-move-date[data-id="${id}"]`, input);
  app.controls.set(`.modal-move-save[data-id="${id}"]`, save);
  return { input, save, form };
}
function renderedDateInput(app, id) {
  return (app.nodes.get('taskList').innerHTML.match(/<input\b[^>]*>/g) || [])
    .find(tag => tag.includes('modal-move-date') && tag.includes(`data-id="${id}"`)) || '';
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

test('date-move permission and native draggable markup are confined to editable assignments', async () => {
  for (const is_admin of [false, true]) {
    const data = moveFixtures();
    data[1] = { ...data[1], target_class: 2, is_completed: 0 };
    const app = await calendar({ id: 11, is_admin, can_complete_assignments: true, grade: 1, class_number: 2 }, data);
    assert.equal(app.run('canMoveAssignment(API.getUser(), assignments[0])'), true);
    assert.equal(app.run('canMoveAssignment(API.getUser(), assignments[1])'), is_admin);
    assert.equal(app.run('canMoveAssignment(API.getUser(), assignments[2])'), is_admin, 'an authored task in a former class is not editable as a student');
    assert.equal(app.run('canMoveAssignment(API.getUser(), assignments[3])'), is_admin);
    assert.equal(app.run('canMoveAssignment(null, assignments[0])'), false);
    const html = app.nodes.get('calendarBody').innerHTML;
    const own = html.match(/<[^>]*data-move-id="1"[^>]*>/)?.[0];
    const other = html.match(/<[^>]*data-move-id="2"[^>]*>/)?.[0];
    assert.match(own || '', /draggable="true"/);
    assert.match(other || '', new RegExp(`draggable="${is_admin ? 'true' : 'false'}"`));
  }
});

test('unauthorized, missing, invalid and unchanged date moves never send a request or change data', async () => {
  const app = await calendar({ id: 11, is_admin: false, can_complete_assignments: true, grade: 1, class_number: 2 }, moveFixtures());
  const before = app.run('JSON.stringify(assignments)');
  for (const [id, date] of [[2, shiftedDay(1)], [3, shiftedDay(1)], [4, shiftedDay(1)], [999, shiftedDay(1)], [1, '2026-02-30'], [1, 'not-a-date'], [1, day]]) {
    await app.run(`moveAssignmentDate(${id}, ${JSON.stringify(date)})`);
  }
  await app.run(`moveAssignmentDate(1, '${shiftedDay(1)}', '${shiftedDay(-1)}')`);
  assert.equal(app.moves.length, 0);
  assert.equal(app.run('JSON.stringify(assignments)'), before);
});

test('date moves paint optimistically and block overlapping move, completion and delete writes for that assignment', async () => {
  const app = await calendar({ id: 11, is_admin: false, can_complete_assignments: true, grade: 1, class_number: 2 }, moveFixtures());
  const response = deferred(), nextDate = shiftedDay(1);
  let calls = 0, completionCalls = 0, deleteCalls = 0, args;
  app.API.moveAssignment = (...values) => { calls++; args = values; return response.promise; };
  app.API.toggleAssignment = async () => { completionCalls++; return { success: true }; };
  app.API.deleteAssignment = async () => { deleteCalls++; return { success: true }; };
  const moving = app.run(`moveAssignmentDate(1, '${nextDate}')`);
  assert.equal(app.run('assignments[0].due_date'), nextDate);
  assert.equal(app.data[0].due_date, day, 'optimistic edits must not mutate a GET/cache payload');
  assert.equal(app.run('pendingAssignmentOperations.size'), 1);
  assert.deepEqual(args, [1, nextDate, day]);
  assert.ok(app.toasts.some(toast => /저장 중/.test(toast.message)));
  await app.run(`moveAssignmentDate(1, '${shiftedDay(2)}')`);
  const controls = rowControls(app, 1);
  await app.listeners.get('taskList:change')({ target: controls.checkbox });
  await app.listeners.get('taskList:click')({ target: controls.deletion });
  assert.equal(calls, 1);
  assert.equal(completionCalls, 0);
  assert.equal(deleteCalls, 0);
  assert.equal(app.run('assignments[0].due_date'), nextDate);
  response.resolve({ success: true, due_date: nextDate });
  await moving;
  assert.equal(app.run('assignments[0].due_date'), nextDate);
  assert.equal(app.run('pendingAssignmentOperations.size'), 0);
});

test('a failed date move rolls back only its assignment while another move stays confirmed', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 }, moveFixtures());
  const first = deferred(), second = deferred(), oneDate = shiftedDay(1), twoDate = shiftedDay(2);
  app.API.moveAssignment = id => id === 1 ? first.promise : second.promise;
  const movingOne = app.run(`moveAssignmentDate(1, '${oneDate}')`);
  const movingTwo = app.run(`moveAssignmentDate(2, '${twoDate}')`);
  assert.deepEqual(Array.from(app.run('assignments.slice(0, 2).map(task => task.due_date)')), [oneDate, twoDate]);
  second.resolve({ success: true, due_date: twoDate }); await movingTwo;
  first.resolve({ success: false, error: '날짜 저장 실패' }); await movingOne;
  assert.deepEqual(Array.from(app.run('assignments.map(task => task.due_date)')), [day, twoDate, day, day]);
  assert.deepEqual(Array.from(app.run('assignments.map(task => task.is_completed)')), [0, 1, 1, 1]);
  assert.equal(app.run('pendingAssignmentOperations.size'), 0);
  assert.equal(app.toasts.at(-1).error, true);
});

test('a date conflict adopts the authoritative server date instead of silently restoring the old date', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 }, moveFixtures());
  const response = deferred(), serverDate = shiftedDay(3);
  app.API.moveAssignment = () => response.promise;
  const moving = app.run(`moveAssignmentDate(1, '${shiftedDay(1)}')`);
  response.resolve({ success: false, status: 409, code: 'ASSIGNMENT_DATE_CONFLICT', due_date: serverDate, error: '다른 사용자가 날짜를 변경했습니다.' });
  await moving;
  assert.equal(app.run('assignments[0].due_date'), serverDate);
  assert.equal(app.run('pendingAssignmentOperations.size'), 0);
  assert.equal(app.toasts.at(-1).error, true);
});

test('a late read started before a date move cannot undo the optimistic or confirmed date', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 }, moveFixtures());
  const read = deferred(), response = deferred(), nextDate = shiftedDay(1);
  app.API.getAssignments = () => read.promise;
  const loading = app.run('loadAssignments()');
  app.API.moveAssignment = () => response.promise;
  const moving = app.run(`moveAssignmentDate(1, '${nextDate}')`);
  read.resolve(moveFixtures()); await loading;
  assert.equal(app.run('assignments[0].due_date'), nextDate);
  response.resolve({ success: true, due_date: nextDate }); await moving;
  assert.equal(app.run('assignments[0].due_date'), nextDate);
});

test('a load during a pending date move preserves its patch and a failure restores the latest server date and content', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 }, moveFixtures());
  const response = deferred(), nextDate = shiftedDay(1), serverDate = shiftedDay(3);
  app.API.moveAssignment = () => response.promise;
  const moving = app.run(`moveAssignmentDate(1, '${nextDate}')`);
  const latest = moveFixtures(); latest[0].due_date = serverDate; latest[0].title = '최신 과제 설명';
  app.API.getAssignments = async () => latest;
  await app.run('loadAssignments()');
  assert.equal(app.run('assignments[0].due_date'), nextDate);
  assert.equal(app.run('assignments[0].title'), '최신 과제 설명');
  assert.equal(latest[0].due_date, serverDate);
  response.resolve({ success: false, error: '일시적인 연결 실패' }); await moving;
  assert.equal(app.run('assignments[0].due_date'), serverDate);
  assert.equal(app.run('assignments[0].title'), '최신 과제 설명');
});

test('a date-move failure cannot resurrect an assignment absent from a newer authoritative load', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 }, moveFixtures());
  const response = deferred();
  app.API.moveAssignment = () => response.promise;
  const moving = app.run(`moveAssignmentDate(1, '${shiftedDay(1)}')`);
  app.API.getAssignments = async () => moveFixtures().filter(task => task.assignment_id !== 1);
  await app.run('loadAssignments()');
  response.resolve({ success: false, error: '이미 삭제된 과제' }); await moving;
  assert.deepEqual(Array.from(app.run('assignments.map(task => task.assignment_id)')), [2, 3, 4]);
  assert.equal(app.run('pendingAssignmentOperations.size'), 0);
});

test('late date-move success, conflicts and failures cannot mutate a new account, class or role view', async () => {
  for (const patch of [{ id: 90 }, { grade: 2, class_number: 3 }, { is_admin: false }]) {
    for (const result of [
      { success: true, due_date: shiftedDay(1) },
      { success: false, status: 409, code: 'ASSIGNMENT_DATE_CONFLICT', due_date: shiftedDay(3), error: '늦은 충돌' },
      { success: false, error: '늦은 실패' }
    ]) {
      const user = { id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 };
      const app = await calendar(user, moveFixtures());
      const response = deferred(); app.API.moveAssignment = () => response.promise;
      const moving = app.run(`moveAssignmentDate(1, '${shiftedDay(1)}')`);
      Object.assign(user, patch);
      const replacement = [{ ...moveFixtures()[0], title: '새 조회 범위의 과제', target_grade: user.grade, target_class: user.class_number, due_date: shiftedDay(5) }];
      app.API.getAssignments = app.API.getUserAssignmentsWithDetails = async () => replacement;
      await app.run('loadAssignments()');
      response.resolve(result); await moving;
      assert.equal(app.run('assignments.length'), 1);
      assert.equal(app.run('assignments[0].title'), '새 조회 범위의 과제');
      assert.equal(app.run('assignments[0].due_date'), shiftedDay(5));
      assert.equal(app.run('pendingAssignmentOperations.size'), 0);
    }
  }
});

test('native dragging moves the selected task, clears drop affordances and suppresses the trailing calendar click', async () => {
  const app = await calendar({ id: 11, is_admin: false, can_complete_assignments: true, grade: 1, class_number: 2 }, moveFixtures());
  const response = deferred(), nextDate = shiftedDay(1), transferred = [];
  app.API.moveAssignment = (...values) => { app.moves.push(values); return response.promise; };
  const tag = { dataset: { moveId: '1' }, closest: selector => selector === '[data-move-id]' ? tag : null };
  const date = { dataset: { date: nextDate }, classList: classes(), contains: () => false, closest: selector => selector === '[data-date]' ? date : null };
  const dataTransfer = { setData: (...values) => transferred.push(values) };
  let startPrevented = false, dropPrevented = false, overPrevented = false, clickPrevented = false;
  app.listeners.get('calendarBody:dragstart')({ target: tag, dataTransfer, preventDefault() { startPrevented = true; } });
  assert.equal(startPrevented, false);
  assert.deepEqual(transferred, [['text/plain', '1']]);
  assert.equal(dataTransfer.effectAllowed, 'move');
  assert.equal(app.nodes.get('calendarBody').classList.contains('is-dragging'), true);
  app.listeners.get('calendarBody:dragover')({ target: date, dataTransfer, preventDefault() { overPrevented = true; } });
  assert.equal(overPrevented, true);
  assert.equal(date.classList.contains('drop-target'), true);
  app.listeners.get('calendarBody:drop')({ target: date, dataTransfer, preventDefault() { dropPrevented = true; } });
  assert.equal(dropPrevented, true);
  assert.equal(app.run('assignments[0].due_date'), nextDate);
  assert.deepEqual(app.moves, [[1, nextDate, day]]);
  assert.equal(date.classList.contains('drop-target'), false);
  assert.equal(app.nodes.get('calendarBody').classList.contains('is-dragging'), false);
  app.listeners.get('calendarBody:click')({ target: date, preventDefault() { clickPrevented = true; } });
  assert.equal(clickPrevented, true);
  assert.equal(app.run('modalDate'), null);
  response.resolve({ success: true, due_date: nextDate });
  await new Promise(setImmediate);
  assert.equal(app.run('pendingAssignmentOperations.size'), 0);
});

test('injected unauthorized drags, changed task dates and changed account scope cannot start a date write', async () => {
  for (const change of ['unauthorized', 'date', 'scope']) {
    const user = { id: 11, is_admin: false, can_complete_assignments: true, grade: 1, class_number: 2 };
    const app = await calendar(user, moveFixtures());
    const id = change === 'unauthorized' ? 3 : 1;
    const tag = { dataset: { moveId: String(id) }, closest: selector => selector === '[data-move-id]' ? tag : null };
    const date = { dataset: { date: shiftedDay(2) }, classList: classes(), closest: selector => selector === '[data-date]' ? date : null };
    let prevented = false;
    app.listeners.get('calendarBody:dragstart')({ target: tag, dataTransfer: { setData() {} }, preventDefault() { prevented = true; } });
    assert.equal(prevented, change === 'unauthorized');
    if (change === 'date') app.run(`assignments[0].due_date = '${shiftedDay(1)}'`);
    if (change === 'scope') user.class_number = 3;
    app.listeners.get('calendarBody:drop')({ target: date, preventDefault() {} });
    assert.equal(app.moves.length, 0);
    assert.equal(app.run('pendingAssignmentOperations.size'), 0);
    assert.equal(app.run('draggedAssignment'), null);
  }
});

test('rerendering the calendar cancels an active native drag before replacing its task elements', async () => {
  const app = await calendar({ id: 11, is_admin: false, can_complete_assignments: true, grade: 1, class_number: 2 }, moveFixtures());
  const tag = { dataset: { moveId: '1' }, closest: selector => selector === '[data-move-id]' ? tag : null };
  const date = { dataset: { date: shiftedDay(1) }, classList: classes(), contains: () => false, closest: selector => selector === '[data-date]' ? date : null };
  const dataTransfer = { setData() {} };
  app.listeners.get('calendarBody:dragstart')({ target: tag, dataTransfer, preventDefault() {} });
  app.listeners.get('calendarBody:dragover')({ target: date, dataTransfer, preventDefault() {} });
  assert.equal(app.run('draggedAssignment.id'), 1);
  assert.equal(date.classList.contains('drop-target'), true);
  app.run('renderCalendar()');
  assert.equal(app.run('draggedAssignment'), null);
  assert.equal(date.classList.contains('drop-target'), false);
  assert.equal(app.nodes.get('calendarBody').classList.contains('is-dragging'), false);
  app.listeners.get('calendarBody:drop')({ target: date, dataTransfer, preventDefault() {} });
  assert.equal(app.moves.length, 0);
  assert.equal(app.run('assignments[0].due_date'), day);
  assert.equal(app.run('pendingAssignmentOperations.size'), 0);
});

test('ordinary own-task and admin drags share an attached custom preview with an unparsed title', async () => {
  const previews = [];
  const title = '<img src=x onerror="unexpected()"> 과제 & 확인';
  for (const is_admin of [false, true]) {
    const data = moveFixtures(); data[0].title = title;
    const app = await calendar({ id: 11, is_admin, can_complete_assignments: true, grade: 1, class_number: 2 }, data);
    const tag = { dataset: { moveId: '1' }, closest: selector => selector === '[data-move-id]' ? tag : null };
    const calls = [];
    const dataTransfer = { setData() {}, setDragImage(element, x, y) {
      calls.push({ element, x, y, connected: element.isConnected, parent: element.parentNode });
    } };
    let prevented = false;
    app.listeners.get('calendarBody:dragstart')({ target: tag, dataTransfer, preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(app.run('draggedAssignment.id'), 1);
    assert.equal(calls.length, 1);
    const { element, x, y, connected, parent } = calls[0];
    assert.equal(element.tagName, 'DIV');
    assert.equal(element.className, 'calendar-drag-preview');
    assert.equal(connected, true, 'the browser receives an attached element as its drag image');
    assert.equal(parent, app.document.body);
    assert.deepEqual([x, y], [12, 18]);
    assert.equal(element.textContent, title);
    assert.equal(element.innerHTML, '', 'the title must be assigned as text instead of HTML');
    assert.equal(app.run('calendarDragPreview'), element);
    assert.deepEqual(app.document.body.children, [element]);
    previews.push({ className: element.className, textContent: element.textContent });
  }
  assert.deepEqual(previews[0], previews[1]);
});

test('custom drag previews are removed on drop, dragend, rerender and scope cancellation', async () => {
  for (const cleanup of ['drop', 'end', 'render', 'scope']) {
    const user = { id: 11, is_admin: false, can_complete_assignments: true, grade: 1, class_number: 2 };
    const app = await calendar(user, moveFixtures());
    const tag = { dataset: { moveId: '1' }, closest: selector => selector === '[data-move-id]' ? tag : null };
    let preview;
    const dataTransfer = { setData() {}, setDragImage(element) { preview = element; } };
    app.listeners.get('calendarBody:dragstart')({ target: tag, dataTransfer, preventDefault() {} });
    assert.equal(preview.isConnected, true);
    if (cleanup === 'drop') {
      const date = { dataset: { date: shiftedDay(1) }, closest: selector => selector === '[data-date]' ? date : null };
      app.listeners.get('calendarBody:drop')({ target: date, dataTransfer, preventDefault() {} });
      await new Promise(setImmediate);
    } else if (cleanup === 'end') app.listeners.get('calendarBody:dragend')();
    else if (cleanup === 'render') app.run('renderCalendar()');
    else { user.class_number = 3; app.run('synchronizeViewScope()'); }
    assert.equal(preview.isConnected, false, cleanup);
    assert.equal(preview.parentNode, null, cleanup);
    assert.equal(app.document.body.children.length, 0, cleanup);
    assert.equal(app.run('calendarDragPreview'), null, cleanup);
    assert.equal(app.run('draggedAssignment'), null, cleanup);
  }
});

test('unsupported or failing custom drag images retain a valid native drag and leave no preview element', async () => {
  for (const support of ['missing', 'throws']) {
    const app = await calendar({ id: 11, is_admin: false, can_complete_assignments: true, grade: 1, class_number: 2 }, moveFixtures());
    const tag = { dataset: { moveId: '1' }, closest: selector => selector === '[data-move-id]' ? tag : null };
    const dataTransfer = { setData() {} };
    if (support === 'throws') dataTransfer.setDragImage = () => { throw new Error('Browser rejected the preview.'); };
    let prevented = false;
    app.listeners.get('calendarBody:dragstart')({ target: tag, dataTransfer, preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(app.run('draggedAssignment.id'), 1);
    assert.equal(dataTransfer.effectAllowed, 'move');
    assert.equal(app.document.body.children.length, 0);
    assert.equal(app.run('calendarDragPreview'), null);
    assert.equal(app.createdElements.length, support === 'missing' ? 0 : 1);
    const date = { dataset: { date: shiftedDay(1) }, closest: selector => selector === '[data-date]' ? date : null };
    app.listeners.get('calendarBody:drop')({ target: date, dataTransfer, preventDefault() {} });
    await new Promise(setImmediate);
    assert.equal(app.moves.length, 1);
    assert.equal(app.run('assignments[0].due_date'), shiftedDay(1));
    assert.equal(app.document.body.children.length, 0);
  }
});

for (const outcome of ['success', 'failure', 'conflict']) {
  test(`modal date input and save button regain focus after a ${outcome} replaces their controls`, async () => {
    for (const focused of ['input', 'save']) {
      const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 }, moveFixtures());
      app.run(`openModal('${day}')`);
      const first = modalDateControls(app, 1);
      first[focused].focus();
      const response = deferred(), nextDate = shiftedDay(1), serverDate = shiftedDay(3);
      app.API.moveAssignment = () => response.promise;
      const moving = app.run(`moveAssignmentDate(1, '${nextDate}')`);
      assert.equal(app.run('modalDate'), nextDate, 'the modal follows the optimistic date');
      first.input.isConnected = first.save.isConnected = false;
      first.input.disabled = first.save.disabled = true;
      const expectedDate = outcome === 'failure' ? day : outcome === 'conflict' ? serverDate : nextDate;
      const replacement = modalDateControls(app, 1, expectedDate);
      app.document.activeElement = app.nodes.get('modal-content');
      response.resolve(outcome === 'success' ? { success: true, due_date: nextDate }
        : outcome === 'conflict' ? { success: false, status: 409, code: 'ASSIGNMENT_DATE_CONFLICT', due_date: serverDate, error: '동시 변경' }
          : { success: false, error: '날짜 저장 실패' });
      await moving;
      assert.equal(app.run('modalDate'), expectedDate);
      assert.equal(app.run('assignments[0].due_date'), expectedDate);
      assert.equal(app.document.activeElement, replacement[focused], 'focus returns from the modal container to the replacement control');
      assert.ok(renderedDateInput(app, 1).includes(`value="${expectedDate}"`));
      assert.ok(!renderedDateInput(app, 1).includes(' disabled'));
    }
  });
}

test('an unfinished date draft survives another assignment save and subsequent modal refreshes', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 }, moveFixtures());
  const response = deferred(), draftDate = shiftedDay(3);
  app.API.moveAssignment = () => response.promise;
  // Move A, then open its former day and edit B while A is still saving.
  const moving = app.run(`moveAssignmentDate(1, '${shiftedDay(1)}')`);
  app.run(`openModal('${day}')`);
  const second = modalDateControls(app, 2, draftDate);
  app.listeners.get('taskList:input')({ target: second.input });
  assert.equal(app.run('assignmentDateDrafts.get(2).value'), draftDate);
  assert.equal(app.run('assignments[1].due_date'), day, 'a form draft does not change the saved assignment');
  response.resolve({ success: true, due_date: shiftedDay(1) }); await moving;
  assert.ok(renderedDateInput(app, 2).includes(`value="${draftDate}"`));
  app.run(`openModal('${day}')`);
  assert.ok(renderedDateInput(app, 2).includes(`value="${draftDate}"`));
  assert.equal(app.run('assignmentDateDrafts.get(2).previousDueDate'), day);
});

test('date drafts clear on account, class and role changes rather than entering a new view', async () => {
  for (const patch of [{ id: 90 }, { class_number: 3 }, { is_admin: false }]) {
    const user = { id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 };
    const app = await calendar(user, moveFixtures());
    app.run(`openModal('${day}')`);
    const controls = modalDateControls(app, 1, shiftedDay(3));
    app.listeners.get('taskList:input')({ target: controls.input });
    assert.equal(app.run('assignmentDateDrafts.size'), 1);
    Object.assign(user, patch);
    const replacement = [{ ...moveFixtures()[0], created_by: user.id, target_class: user.class_number, due_date: shiftedDay(5) }];
    app.API.getAssignments = app.API.getUserAssignmentsWithDetails = async () => replacement;
    await app.run('loadAssignments()');
    assert.equal(app.run('assignmentDateDrafts.size'), 0);
    app.run(`openModal('${shiftedDay(5)}')`);
    assert.ok(renderedDateInput(app, 1).includes(`value="${shiftedDay(5)}"`));
    assert.ok(!renderedDateInput(app, 1).includes(`value="${shiftedDay(3)}"`));
  }
});

test('school events are escaped read-only date labels and never count as assignments or completion', async () => {
  const app = await calendar({ id: 11, grade: 1, class_number: 2, is_admin: false, can_complete_assignments: true });
  const progress = app.nodes.get('progressCount').textContent;
  app.API.getSchoolEvents = async month => ({ month, updatedAt: '2026-11-19T00:00:00Z', events: [
    { id: 'exam', date: day, title: '<기말고사>', detail: '<script>unsafe</script>', grades: [1], category: 'exam' },
    { id: 'other', date: day, title: '2학년 시험', grades: [2], category: 'exam' }
  ] });
  await app.run('loadSchoolEvents()');
  const html = app.nodes.get('calendarBody').innerHTML;
  assert.match(html, /school-event-tag exam/); assert.match(html, /&lt;기말고사>/); assert.ok(!html.includes('2학년 시험'));
  assert.ok(!html.includes('data-move-id="exam"')); assert.equal(app.nodes.get('progressCount').textContent, progress);
  app.run(`openModal('${day}')`);
  const details = app.nodes.get('taskList').innerHTML;
  assert.match(details, /읽기 전용/); assert.match(details, /&lt;script>/); assert.ok(!details.includes('<script>'));
  app.listeners.get('showSchoolEvents:change')({ target: { checked: false } });
  assert.ok(!app.nodes.get('calendarBody').innerHTML.includes('school-event-tag')); assert.ok(!app.nodes.get('taskList').innerHTML.includes('학교 일정'));
});
test('late school reads cannot replace another month or another account scope', async () => {
  const user = { id: 11, grade: 1, class_number: 2, is_admin: false, can_complete_assignments: true };
  const app = await calendar(user);
  const first = deferred(), second = deferred(); let calls = 0;
  app.API.getSchoolEvents = () => ++calls === 1 ? first.promise : second.promise;
  const old = app.run('loadSchoolEvents()');
  app.run('changeMonth(1)');
  const newDay = app.run('schoolMonth()') + '-10';
  second.resolve({ events: [{ date: newDay, title: '새 달', grades: [1] }], updatedAt: 'now' });
  await new Promise(setImmediate);
  first.resolve({ events: [{ date: day, title: '이전 달', grades: [1] }] }); await old;
  assert.match(app.nodes.get('calendarBody').innerHTML, /새 달/); assert.ok(!app.nodes.get('calendarBody').innerHTML.includes('이전 달'));
  const accountRead = deferred(); app.API.getSchoolEvents = () => accountRead.promise;
  const stale = app.run('loadSchoolEvents()'); user.id = 12; user.grade = 2; app.run('synchronizeViewScope(); renderCalendar()');
  accountRead.resolve({ events: [{ date: newDay, title: '이전 사용자', grades: [2] }] }); await stale;
  assert.ok(!app.nodes.get('calendarBody').innerHTML.includes('이전 사용자'));
});
test('school errors allow tasks to stay visible and administrators filter school events by grade', async () => {
  const app = await calendar({ id: 11, grade: 1, class_number: 2, is_admin: true, can_complete_assignments: true });
  app.API.getSchoolEvents = async () => { throw new Error('잠시 후 다시 시도해주세요.'); };
  await app.run('loadSchoolEvents()');
  assert.match(app.nodes.get('calendarBody').innerHTML, /내 반 과제/); assert.equal(app.nodes.get('retrySchoolEvents').hidden, false);
  app.API.getSchoolEvents = async () => ({ events: [{ date: day, title: '1학년 시험', grades: [1] }, { date: day, title: '2학년 시험', grades: [2] }], updatedAt: 'now' });
  await app.run('loadSchoolEvents()');
  app.listeners.get('adminGradeFilter:change')({ target: { value: '2' } });
  assert.match(app.nodes.get('calendarBody').innerHTML, /2학년 시험/); assert.ok(!app.nodes.get('calendarBody').innerHTML.includes('1학년 시험'));
  assert.equal(app.nodes.get('retrySchoolEvents').hidden, true);
});
