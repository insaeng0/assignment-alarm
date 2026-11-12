const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function classes() {
  const values = new Set();
  return { add: value => values.add(value), remove: value => values.delete(value), contains: value => values.has(value), toggle(value, force) {
    const on = force === undefined ? !values.has(value) : force;
    if (on) values.add(value); else values.delete(value);
    return on;
  } };
}
const account = () => ({ id: 90, name: '관리자', grade: 1, class_number: 1, is_admin: true, is_alarm_enabled: true, can_complete_assignments: true });
const user = (id, extra = {}) => ({ user_id: id, name: `학생${id}`, grade: 1, class_number: 1, is_admin: false, google_email: `26_${id}@bssm.hs.kr`, created_at: '2026-11-12T00:00:00Z', ...extra });
const assignment = (id, extra = {}) => ({ assignment_id: id, title: `과제${id}`, target_grade: 1, target_class: 1, due_date: '2026-11-20', created_by: 1, ...extra });
const message = (id, extra = {}) => ({ message_id: id, content: `공지${id}`, type: 'grade', target_grade: 1, target_class: null, sender_id: 1, created_at: '2026-11-12T00:00:00Z', ...extra });

function settings({ initialUser = account(), api = {} } = {}) {
  let currentUser = initialUser && { ...initialUser };
  const nodes = new Map(), listeners = new Map(), toasts = [], calls = [], confirmations = [];
  const node = id => {
    if (!nodes.has(id)) {
      const attrs = new Map();
      nodes.set(id, { id, classList: classes(), style: {}, dataset: {}, innerHTML: '', textContent: '', value: '', disabled: false,
        setAttribute: (key, value) => attrs.set(key, value), getAttribute: key => attrs.get(key), appendChild() {},
        addEventListener: (kind, callback) => listeners.set(id + ':' + kind, callback) });
    }
    return nodes.get(id);
  };
  const never = () => new Promise(() => {});
  const API = {
    initTheme() {}, requireAuth() {}, getUser: () => currentUser,
    setUser: value => { currentUser = { ...value }; }, ensureUser: never,
    loadUserInfo() {}, initNotifications: async () => {}, refreshNotifications: async () => {},
    normalizeFlag: value => value === true || value === 1 || value === '1',
    isSafeImageUrl: () => false, getTheme: () => 'light', getResolvedTheme: () => 'light',
    escapeHTML: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    renderTextWithLinks: value => String(value), getCachedData: () => null,
    getAdminAssignments: never, getAdminMessages: never, getAdminUsers: never,
    updateUser: (...args) => { calls.push(['updateUser', ...args]); return never(); },
    updateAdminUser: (...args) => { calls.push(['updateAdminUser', ...args]); return never(); },
    deleteAdminUser: (...args) => { calls.push(['deleteAdminUser', ...args]); return never(); }, ...api
  };
  const document = { getElementById: node, querySelectorAll: () => [], createElement: () => node('created'), addEventListener: (kind, callback) => listeners.set('document:' + kind, callback) };
  const context = vm.createContext({ API, document, window: { addEventListener() {} }, URLSearchParams, Date,
    AppUI: { toast: (text, error = false) => toasts.push({ text, error }) },
    confirm: text => { confirmations.push(text); return true; }, alert: text => { throw new Error('Blocking alert: ' + text); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/settings.js'), 'utf8'), context);
  return { API, nodes, node, listeners, toasts, calls, confirmations, context,
    run: code => vm.runInContext(code, context),
    state: () => JSON.parse(vm.runInContext('JSON.stringify(adminSettingsState)', context)),
    records(kind, records) {
      const fields = { user: ['users', 'userTotal'], assignment: ['assignments', 'assignmentTotal'], message: ['messages', 'messageTotal'] }[kind];
      vm.runInContext(`adminSettingsState.${fields[0]} = ${JSON.stringify(records)}; adminSettingsState.${fields[1]} = ${records.length}; renderAdminList('${kind}');`, context);
    }
  };
}
const tick = () => new Promise(setImmediate);

test('cached profile and visible admin assignments render before identity or list requests resolve', () => {
  const cached = { items: [assignment(1)], total: 1, page: 1 };
  const app = settings({ api: { getCachedData: url => url.startsWith('/api/admin/assignments?') ? cached : null } });
  assert.equal(app.node('settingName').value, '관리자');
  assert.equal(app.node('alarmToggle').getAttribute('aria-checked'), 'true');
  assert.equal(app.node('adminAssignmentSection').style.display, 'block');
  assert.ok(app.node('adminAssignmentList').innerHTML.includes('과제1'));
  assert.equal(app.state().assignments.length, 1);
});

test('alarm changes UI and cached preference immediately, ignores duplicates and rolls back only that field', async () => {
  const write = deferred(); let writes = 0;
  const app = settings({ api: { updateUser: () => { writes += 1; return write.promise; } } });
  const toggle = app.node('alarmToggle');
  const handler = app.listeners.get('alarmToggle:click');
  const operation = handler.call(toggle);
  assert.equal(toggle.classList.contains('on'), false);
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.equal(toggle.getAttribute('aria-busy'), 'true');
  assert.equal(app.API.getUser().is_alarm_enabled, false);
  await handler.call(toggle);
  assert.equal(writes, 1);
  app.API.setUser({ ...app.API.getUser(), name: '새 이름' });
  write.resolve({ success: false, error: '서버 저장 실패' });
  await operation;
  assert.equal(toggle.classList.contains('on'), true);
  assert.equal(app.API.getUser().is_alarm_enabled, true);
  assert.equal(app.API.getUser().name, '새 이름');
  assert.equal(toggle.disabled, false);
  assert.match(app.toasts.at(-1).text, /서버 저장 실패/);
  assert.equal(app.toasts.at(-1).error, true);
});

test('a delayed profile refresh cannot hide a pending alarm preference and a failed old-account write cannot affect a new account', async () => {
  const write = deferred();
  const app = settings({ api: { updateUser: () => write.promise } });
  const toggle = app.node('alarmToggle');
  const operation = app.listeners.get('alarmToggle:click').call(toggle);
  await app.run(`loadProfile(${JSON.stringify(account())})`);
  assert.equal(toggle.classList.contains('on'), false);
  assert.equal(app.API.getUser().is_alarm_enabled, false);
  app.API.setUser({ ...account(), id: 91, is_alarm_enabled: false });
  write.resolve({ success: false });
  await operation;
  assert.equal(app.API.getUser().id, 91);
  assert.equal(app.API.getUser().is_alarm_enabled, false);
  assert.equal(toggle.classList.contains('on'), false);
});

test('admin class edits paint a pending row before server response and rollback never replaces another record or role', async () => {
  const write = deferred(); let writes = 0;
  const app = settings({ api: { updateAdminUser: () => { writes += 1; return write.promise; } } });
  app.records('user', [user(1), user(2)]);
  const operation = app.run('saveAdminUser(1, { grade: 2, class_number: 3 })');
  assert.equal(app.state().users[0].grade, 2);
  assert.equal(app.state().users[0].class_number, 3);
  assert.equal(app.state().users[0].is_admin, false);
  assert.match(app.node('adminUserList').innerHTML, /저장 중…/);
  await app.run('saveAdminUser(1, { grade: 3, class_number: 4 })');
  assert.equal(writes, 1);
  app.run("adminSettingsState.users[0].name = '최신 이름'; adminSettingsState.users[1].grade = 3;");
  write.resolve({ success: false, error: '권한이 없습니다.' });
  await operation;
  assert.equal(app.state().users[0].grade, 1);
  assert.equal(app.state().users[0].class_number, 1);
  assert.equal(app.state().users[0].name, '최신 이름');
  assert.equal(app.state().users[1].grade, 3);
  assert.equal(app.state().users[0].is_admin, false);
  assert.ok(!app.node('adminUserList').innerHTML.includes('저장 중…'));
  assert.match(app.toasts.at(-1).text, /권한이 없습니다/);
});

test('successful class edits remain visible while the authoritative reload is pending or fails', async () => {
  const write = deferred(), reload = deferred(); let reads = 0;
  const app = settings({ api: { updateAdminUser: () => write.promise, getAdminUsers: () => { reads += 1; return reload.promise; } } });
  app.records('user', [user(1)]);
  const operation = app.run('saveAdminUser(1, { grade: 2, class_number: 4 })');
  write.resolve({ success: true });
  await operation;
  assert.equal(reads, 1);
  assert.equal(app.state().users[0].grade, 2);
  assert.ok(!app.node('adminUserList').innerHTML.includes('저장 중…'));
  reload.resolve({ error: '읽기 실패' });
  await tick();
  assert.equal(app.state().users[0].class_number, 4);
  assert.ok(app.node('adminUserList').innerHTML.includes('학생1'));
});

test('old reads cannot overwrite an optimistic class edit and simultaneous edits settle independently', async () => {
  const oldRead = deferred(), first = deferred(), second = deferred();
  const app = settings({ api: { getAdminUsers: () => oldRead.promise, updateAdminUser: id => id === 1 ? first.promise : second.promise } });
  app.records('user', [user(1), user(2)]);
  const reading = app.run('loadAdminUsers()');
  const one = app.run('saveAdminUser(1, { grade: 2, class_number: 2 })');
  const two = app.run('saveAdminUser(2, { grade: 3, class_number: 4 })');
  oldRead.resolve({ items: [user(1), user(2)], total: 2, page: 1 });
  await reading;
  assert.equal(app.state().users[0].grade, 2);
  assert.equal(app.state().users[1].grade, 3);
  first.resolve({ error: '첫 저장 실패' });
  await one;
  assert.equal(app.state().users[0].grade, 1);
  assert.equal(app.state().users[1].grade, 3);
  second.resolve({ error: '두 번째 실패' });
  await two;
  assert.equal(app.state().users[1].grade, 1);
});

test('assignment deletion hides immediately, suppresses duplicates and stale reloads, then restores only its row on failure', async () => {
  const remove = deferred(), reading = deferred(); let deletes = 0;
  const app = settings({ api: { deleteAssignment: () => { deletes += 1; return remove.promise; }, getAdminAssignments: () => reading.promise } });
  app.records('assignment', [assignment(1), assignment(2)]);
  const operation = app.run("deleteAdminRecord('assignment', 1, id => API.deleteAssignment(id))");
  assert.deepEqual(app.state().assignments.map(row => row.assignment_id), [2]);
  assert.equal(app.state().assignmentTotal, 1);
  await app.run("deleteAdminRecord('assignment', 1, id => API.deleteAssignment(id))");
  assert.equal(deletes, 1);
  const loading = app.run('loadAdminAssignments()');
  reading.resolve({ items: [assignment(1), assignment(2)], total: 2, page: 1 });
  await loading;
  assert.deepEqual(app.state().assignments.map(row => row.assignment_id), [2]);
  app.run("adminSettingsState.assignments[0].title = '다른 과제 최신 내용'");
  remove.resolve({ error: '삭제 권한 없음' });
  await operation;
  assert.deepEqual(app.state().assignments.map(row => row.assignment_id), [1, 2]);
  assert.equal(app.state().assignments[1].title, '다른 과제 최신 내용');
  assert.equal(app.state().assignmentTotal, 2);
});

test('a failed delete from a previous filter never inserts its row into the new filtered list', async () => {
  const remove = deferred();
  const app = settings({ api: { deleteMessage: () => remove.promise } });
  app.records('message', [message(1)]);
  const operation = app.run("deleteAdminRecord('message', 1, id => API.deleteMessage(id))");
  app.run("adminSettingsState.messageType = 'class'; adminSettingsState.messages = [{ message_id: 3, content: '새 필터 공지', type: 'class', target_grade: 2, target_class: 2 }]; adminSettingsState.messageTotal = 1;");
  remove.resolve({ error: '통신 실패' });
  await operation;
  assert.deepEqual(app.state().messages.map(row => row.message_id), [3]);
  assert.equal(app.state().messageTotal, 1);
});

test('user deletion keeps its existing confirmation explicit, hides the row immediately and reconciles related content only after success', async () => {
  const remove = deferred();
  const app = settings({ api: { deleteAdminUser: () => remove.promise } });
  app.records('user', [user(1), user(2)]);
  app.records('assignment', [assignment(1), assignment(2, { created_by: 2 })]);
  app.records('message', [message(1), message(2, { sender_id: 2 })]);
  const item = { dataset: { id: '1' } };
  const button = { disabled: false, closest: selector => selector === '.admin-user-item' ? item : selector === '.delete-admin-user' ? button : null };
  const operation = app.listeners.get('adminUserList:click')({ target: button });
  assert.match(app.confirmations[0], /계정.*과제·공지/);
  assert.deepEqual(app.state().users.map(row => row.user_id), [2]);
  assert.equal(app.state().assignments.length, 2);
  remove.resolve({ success: true });
  await operation;
  assert.deepEqual(app.state().assignments.map(row => row.assignment_id), [2]);
  assert.deepEqual(app.state().messages.map(row => row.message_id), [2]);
  assert.equal(app.state().adminLoaded.assignment, false);
  assert.equal(app.state().adminLoaded.message, false);
});

test('failed user deletion restores the user and does not remove their tasks or notices', async () => {
  const remove = deferred();
  const app = settings({ api: { deleteAdminUser: () => remove.promise } });
  app.records('user', [user(1)]);
  app.records('assignment', [assignment(1)]);
  app.records('message', [message(1)]);
  const operation = app.run("deleteAdminRecord('user', 1, id => API.deleteAdminUser(id))");
  remove.resolve({ error: '서버 오류' });
  await operation;
  assert.equal(app.state().users.length, 1);
  assert.equal(app.state().assignments.length, 1);
  assert.equal(app.state().messages.length, 1);
});

test('unverified local admin permission never starts optimistic admin writes', async () => {
  const app = settings({ initialUser: { ...account(), is_admin: false } });
  app.records('user', [user(1)]);
  app.records('assignment', [assignment(1)]);
  await app.run('saveAdminUser(1, { grade: 2, class_number: 2 })');
  await app.run("deleteAdminRecord('assignment', 1, id => API.deleteAssignment(id))");
  assert.equal(app.state().users[0].grade, 1);
  assert.equal(app.state().assignments.length, 1);
  assert.equal(app.calls.length, 0);
});

test('overlapping failed deletes restore the original order regardless of response order', async () => {
  for (const responseOrder of [[1, 2], [2, 1]]) {
    const writes = { 1: deferred(), 2: deferred() };
    const app = settings({ api: { deleteAssignment: id => writes[id].promise } });
    app.records('assignment', [assignment(1), assignment(2), assignment(3)]);
    const operations = {
      1: app.run("deleteAdminRecord('assignment', 1, id => API.deleteAssignment(id))"),
      2: app.run("deleteAdminRecord('assignment', 2, id => API.deleteAssignment(id))")
    };
    for (const id of responseOrder) { writes[id].resolve({ error: '실패' }); await operations[id]; }
    assert.deepEqual(app.state().assignments.map(row => row.assignment_id), [1, 2, 3]);
    assert.equal(app.state().assignmentTotal, 3);
  }
});

test('a confirmed user cascade prevents a late failed individual delete from resurrecting their task', async () => {
  const taskWrite = deferred(), userWrite = deferred();
  const app = settings({ api: { deleteAssignment: () => taskWrite.promise, deleteAdminUser: () => userWrite.promise } });
  app.records('assignment', [assignment(1)]);
  app.records('user', [user(1)]);
  const taskDelete = app.run("deleteAdminRecord('assignment', 1, id => API.deleteAssignment(id))");
  const userDelete = app.run("deleteAdminRecord('user', 1, id => API.deleteAdminUser(id))");
  userWrite.resolve({ success: true });
  await userDelete;
  taskWrite.resolve({ error: '이미 삭제된 과제입니다.' });
  await taskDelete;
  assert.equal(app.state().assignments.length, 0);
});

test('same-account role or class changes discard delayed admin reads and their former private rows', async () => {
  for (const change of [{ is_admin: false }, { grade: 2 }]) {
    const reading = deferred();
    const app = settings({ api: { getAdminUsers: () => reading.promise } });
    app.records('user', [user(1)]);
    const operation = app.run('loadAdminUsers()');
    app.API.setUser({ ...app.API.getUser(), ...change });
    reading.resolve({ items: [user(2)], total: 1, page: 1 });
    await operation;
    assert.equal(app.state().users.length, 0);
    assert.equal(app.node('adminUserList').innerHTML, '');
  }
});

test('a pending mutation cannot restore a former account or class record after its scope changes', async () => {
  const write = deferred();
  const app = settings({ api: { updateAdminUser: () => write.promise } });
  app.records('user', [user(1)]);
  const operation = app.run('saveAdminUser(1, { grade: 2, class_number: 2 })');
  app.API.setUser({ ...app.API.getUser(), class_number: 3 });
  write.resolve({ error: '저장 실패' });
  await operation;
  assert.equal(app.state().users.length, 0);
  assert.equal(app.node('adminUserList').innerHTML, '');
  assert.equal(app.API.getUser().class_number, 3);
});
