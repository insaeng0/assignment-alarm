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

async function calendar(user, data = fixtures()) {
  const nodes = new Map(), listeners = new Map(), writes = [], toasts = [], reads = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { classList: classes(), style: {}, dataset: {}, innerHTML: '', textContent: '', value: '',
      addEventListener: (kind, handler) => listeners.set(id + ':' + kind, handler), setAttribute() {}, focus() {}, contains: () => false });
    return nodes.get(id);
  };
  const filterButtons = ['all', 'pending', 'done'].map(value => ({ dataset: { taskFilter: value }, classList: classes(), setAttribute() {}, addEventListener() {} }));
  const document = { getElementById: node, querySelectorAll: () => filterButtons, querySelector: () => node('modal-content'), body: { classList: classes() }, activeElement: node('prior-focus'), addEventListener() {} };
  const API = {
    requireAuth() {}, getUser: () => user, ensureUser: async () => null, loadUserInfo() {},
    escapeHTML: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    renderTextWithLinks: value => String(value),
    getAssignments: async () => { reads.push('admin'); return data; },
    getUserAssignmentsWithDetails: async () => { reads.push('student'); return data; },
    toggleAssignment: async (id, completed) => { writes.push({ id, completed }); return { success: true }; },
    refreshNotifications: async () => {}
  };
  const context = vm.createContext({ API, document, AppUI: { localDate, toast: (message, error) => toasts.push({ message, error }) }, Date, confirm: () => true, window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/calendar.js'), 'utf8'), context);
  await new Promise(setImmediate);
  await vm.runInContext('loadAssignments()', context);
  return { context, nodes, listeners, writes, reads, toasts, API, data, run: code => vm.runInContext(code, context) };
}

test('student and student-admin completion permission is confined to their own class and grade-wide tasks', async () => {
  for (const is_admin of [false, true]) {
    const app = await calendar({ id: 11, is_admin, can_complete_assignments: true, grade: 1, class_number: 2 });
    assert.equal(app.run('canCompleteAssignment(API.getUser(), assignments[0])'), true);
    assert.equal(app.run('canCompleteAssignment(API.getUser(), assignments[1])'), true);
    assert.equal(app.run('canCompleteAssignment(API.getUser(), assignments[2])'), false);
    assert.equal(app.run('canCompleteAssignment(API.getUser(), assignments[3])'), false);
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
  assert.deepEqual(Array.from(app.run("taskFilter = 'all'; getMatchingAssignments().map(task => task.assignment_id)")), [1, 2, 3, 4]);
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

test('student-admin checkbox saves their own completion and keeps the class in updated metadata', async () => {
  const app = await calendar({ id: 11, is_admin: true, can_complete_assignments: true, grade: 1, class_number: 2 });
  const meta = { textContent: '' };
  const item = { classList: classes(), querySelector: () => meta };
  const checkbox = { checked: true, disabled: false, dataset: { id: '1' }, closest: selector => selector === '.modal-submit-toggle' ? checkbox : item };
  await app.listeners.get('taskList:change')({ target: checkbox });
  assert.deepEqual(app.writes, [{ id: 1, completed: true }]);
  assert.equal(app.data[0].is_completed, 1);
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
  const checkbox = { checked: true, disabled: false, dataset: { id: '1' }, closest: () => checkbox };
  await app.listeners.get('taskList:change')({ target: checkbox });
  assert.equal(checkbox.checked, false);
  assert.equal(checkbox.disabled, false);
  assert.equal(app.data[0].is_completed, 0);
  assert.match(app.toasts.at(-1).message, /저장 실패/);
});
