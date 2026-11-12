const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const original = { assignment_id: 11, title: '원래 과제', content: '기존 내용', due_date: '2026-11-20', target_grade: 1, target_class: 2, created_by: 7, creator_name: '학생' };

function element(id = '', classes = [], dataset = {}) {
  const listeners = new Map();
  const names = new Set(classes);
  return {
    id, dataset, value: '', textContent: '', innerHTML: '', disabled: false, hidden: false, style: {}, listeners,
    classList: { contains: name => names.has(name), add: name => names.add(name), remove: name => names.delete(name) },
    addEventListener(name, fn) { const callbacks = listeners.get(name) || []; callbacks.push(fn); listeners.set(name, callbacks); },
    setAttribute(name, value) { this[name] = value; },
    focus() {}, setSelectionRange() {}, click() {}, closest() { return this; },
    reportValidity() { return true; }
  };
}

function setup(options = {}) {
  const nodes = new Map();
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); } };
  const user = options.user || { id: 7, name: '학생', grade: 1, class_number: 2, is_admin: false };
  const calls = { get: 0, create: [], edit: [], delete: [], cache: [], toast: [] };
  const API = {
    requireAuth() {}, ensureUser: async () => user, getUser: () => user, loadUserInfo() {}, initNotifications: async () => {},
    getCachedPublicConfig: () => options.cachedConfig, getCachedData: () => options.cached,
    publicConfig: options.config || (async () => ({ imagesEnabled: false })),
    getAssignments() { calls.get++; return options.get ? options.get() : Promise.resolve(options.seed || [{ ...original }]); },
    createAssignment(payload) { calls.create.push(payload); return options.create?.(payload) || Promise.resolve({ success: true, assignment_id: 42 }); },
    updateAssignment(id, payload) { calls.edit.push({ id, payload }); return options.edit?.(id, payload) || Promise.resolve({ success: true }); },
    deleteAssignment(id) { calls.delete.push(id); return options.delete?.(id) || Promise.resolve({ success: true }); },
    setCachedData(url, data) { calls.cache.push({ url, data }); }, refreshNotifications: async () => {},
    escapeHTML: escape, renderTextWithLinks: escape
  };
  const window = { scrollTo() {}, location: { href: '' } };
  const context = vm.createContext({ API, document, window,
    AppUI: { localDate: () => '2026-11-12', toast: (...args) => calls.toast.push(args) },
    confirm: () => true, alert() {}, Date, JSON, Number, Map, Set, Promise });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/register.js'), 'utf8'), context);
  const node = id => document.getElementById(id);
  const fire = (id, name, event = {}) => Promise.all((node(id).listeners.get(name) || []).map(fn => fn({ preventDefault() {}, currentTarget: node(id), target: node(id), ...event })));
  const submit = () => fire('assignmentForm', 'submit');
  const fill = (title, content = '작성 내용') => { node('taskTitle').value = title; node('taskContent').value = content; node('taskDate').value = '2026-11-21'; };
  const action = (name, id, extra = {}) => fire('myAssignments', 'click', { target: element('', [name], { id: String(id), ...extra }) });
  return { node, calls, user, window, context, fire, fill, submit, action, html: () => node('myAssignments').innerHTML };
}

test('cached assignments render while independent config and fresh list requests are still pending', async () => {
  const config = deferred(), list = deferred();
  const app = setup({ cached: [{ ...original }], cachedConfig: { imagesEnabled: true }, config: () => config.promise, get: () => list.promise });
  await flush();
  assert.equal(app.calls.get, 1, 'list loading must not wait for public configuration');
  assert.ok(app.html().includes('원래 과제'));
  assert.equal(app.node('insertImageBtn').hidden, false);
  list.resolve([{ ...original }]); config.resolve({ imagesEnabled: false });
  await flush();
  assert.equal(app.node('insertImageBtn').hidden, true);
});

test('create stays on the form while pending and redirects only after confirmed data is cached', async () => {
  const save = deferred();
  const app = setup({ create: () => save.promise });
  await flush();
  app.fill('새 과제');
  const done = app.submit();
  assert.equal(app.calls.create.length, 1);
  assert.ok(app.html().includes('새 과제'));
  assert.ok(app.html().includes('저장 중…'));
  assert.match(app.html(), /data-id="pending-1" disabled/);
  assert.equal(app.node('taskTitle').value, '');
  assert.equal(app.node('saveBtn').disabled, false, 'a new draft remains usable during the queued write');
  assert.equal(app.calls.cache.length, 0, 'unconfirmed rows must not enter the private data cache');
  assert.equal(app.window.location.href, '', 'an optimistic row is not a confirmed registration');
  await app.action('delete-my', 'pending-1');
  assert.equal(app.calls.delete.length, 0);
  save.resolve({ success: true, assignment_id: 42 });
  await done;
  assert.match(app.html(), /data-id="42"/);
  assert.ok(app.html().includes('저장됨'));
  assert.ok(!app.html().includes('pending-1'));
  assert.equal(app.calls.get, 1, 'saving does not wait for a second list request');
  assert.equal(app.calls.cache.at(-1).data[0].assignment_id, 42);
  assert.equal(app.calls.cache.at(-1).data[0]._saved, undefined);
  assert.equal(app.window.location.href, 'calendar.html');
});

test('failed creation rolls back only its pending row and restores an untouched draft', async () => {
  const save = deferred();
  const app = setup({ create: () => save.promise });
  await flush(); app.fill('실패한 과제', '보존할 내용');
  const done = app.submit();
  assert.ok(app.html().includes('실패한 과제'));
  save.resolve({ success: false, error: '저장 실패' });
  await done;
  assert.ok(!app.html().includes('실패한 과제'));
  assert.ok(app.html().includes('원래 과제'));
  assert.equal(app.node('taskTitle').value, '실패한 과제');
  assert.equal(app.node('taskContent').value, '보존할 내용');
  assert.equal(app.calls.toast.at(-1)[1], true);
  assert.equal(app.window.location.href, '', 'failed registration must retain the form');
});

test('a failed older save never overwrites a newer draft and remains explicitly recoverable', async () => {
  const save = deferred();
  const app = setup({ create: () => save.promise });
  await flush(); app.fill('이전 입력');
  const done = app.submit();
  app.fill('새로 쓰는 입력'); await app.fire('assignmentForm', 'input');
  save.reject(new Error('네트워크 오류'));
  await done;
  assert.equal(app.node('taskTitle').value, '새로 쓰는 입력');
  assert.ok(app.html().includes('입력 복원'));
  await app.action('restore-draft', '', { operation: 'save-1' });
  assert.equal(app.node('taskTitle').value, '새로 쓰는 입력');
  await app.fire('cancelEditBtn', 'click');
  await app.action('restore-draft', '', { operation: 'save-1' });
  assert.equal(app.node('taskTitle').value, '이전 입력');
  assert.ok(!app.html().includes('입력 복원'));
});

test('edit renders immediately, disables only that pending row, and rolls back without losing its draft', async () => {
  const save = deferred();
  const app = setup({ edit: () => save.promise });
  await flush(); await app.action('edit-my', 11);
  app.fill('수정된 제목');
  const done = app.submit();
  assert.ok(app.html().includes('수정된 제목'));
  assert.ok(!app.html().includes('원래 과제'));
  assert.match(app.html(), /data-id="11" disabled/);
  await app.action('edit-my', 11); await app.action('delete-my', 11);
  assert.equal(app.calls.edit.length, 1);
  assert.equal(app.calls.delete.length, 0);
  save.resolve({ success: false, error: '수정 실패' });
  await done;
  assert.ok(app.html().includes('원래 과제'));
  assert.equal(app.node('taskTitle').value, '수정된 제목');
  assert.equal(app.node('saveBtn').textContent, '수정하기');
});

test('a confirmed edit keeps the registration page and its confirmed cache', async () => {
  const save = deferred();
  const app = setup({ edit: () => save.promise });
  await flush(); await app.action('edit-my', 11);
  app.fill('수정 저장한 제목');
  const done = app.submit();
  assert.equal(app.window.location.href, '');
  save.resolve({ success: true });
  await done;
  assert.equal(app.calls.edit.length, 1);
  assert.equal(app.calls.create.length, 0);
  assert.equal(app.calls.cache.at(-1).data[0].title, '수정 저장한 제목');
  assert.equal(app.window.location.href, '', 'only a newly created assignment returns to the dashboard');
});

test('a create response without a valid saved ID preserves the draft and never navigates', async () => {
  const app = setup({ create: async () => ({ success: true }) });
  await flush(); app.fill('확인하지 못한 과제', '보존할 원문');
  await app.submit();
  assert.equal(app.window.location.href, '');
  assert.equal(app.node('taskTitle').value, '확인하지 못한 과제');
  assert.equal(app.node('taskContent').value, '보존할 원문');
  assert.equal(app.calls.cache.length, 0);
  assert.equal(app.calls.toast.at(-1)[1], true);
});

test('a successful create preserves a newer unsaved draft instead of redirecting', async () => {
  const save = deferred();
  const app = setup({ create: () => save.promise });
  await flush(); app.fill('저장 중인 과제');
  const done = app.submit();
  app.fill('새로 작성하는 과제', '새 초안 내용'); await app.fire('assignmentForm', 'input');
  save.resolve({ success: true, assignment_id: 43 });
  await done;
  assert.equal(app.window.location.href, '');
  assert.equal(app.node('taskTitle').value, '새로 작성하는 과제');
  assert.equal(app.node('taskContent').value, '새 초안 내용');
  assert.equal(app.calls.cache.at(-1).data[0].assignment_id, 43);
});

test('queued creates redirect after the last successful response without dropping another pending save', async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const saves = [deferred(), deferred()];
    const app = setup({ create: payload => saves[payload.title === '첫 과제' ? 0 : 1].promise });
    await flush(); app.fill('첫 과제'); const first = app.submit();
    app.fill('둘째 과제'); const second = app.submit();
    const operations = [first, second];
    saves[order[0]].resolve({ success: true, assignment_id: 50 + order[0] });
    await operations[order[0]];
    assert.equal(app.window.location.href, '', 'the other write is still pending');
    saves[order[1]].resolve({ success: true, assignment_id: 50 + order[1] });
    await operations[order[1]];
    assert.equal(app.window.location.href, 'calendar.html');
    assert.equal(app.calls.cache.at(-1).data.filter(row => row.assignment_id === 50 || row.assignment_id === 51).length, 2);
  }
});

test('a failed queued create keeps its restored or recoverable draft even when another create succeeds', async () => {
  for (const failedFirst of [true, false]) {
    const firstSave = deferred(), secondSave = deferred();
    const app = setup({ create: payload => payload.title === '첫 과제' ? firstSave.promise : secondSave.promise });
    await flush(); app.fill('첫 과제'); const first = app.submit();
    app.fill('둘째 과제'); const second = app.submit();
    if (failedFirst) {
      firstSave.resolve({ error: '첫 저장 실패' }); await first;
      secondSave.resolve({ success: true, assignment_id: 55 }); await second;
      assert.ok(app.html().includes('입력 복원'));
    } else {
      firstSave.resolve({ success: true, assignment_id: 54 }); await first;
      secondSave.resolve({ error: '둘째 저장 실패' }); await second;
      assert.equal(app.node('taskTitle').value, '둘째 과제');
    }
    assert.equal(app.window.location.href, '');
  }
});

test('an active edit or upload blocks a prior create redirect', async () => {
  for (const activity of ['edit', 'upload']) {
    const save = deferred();
    const app = setup({ create: () => save.promise });
    await flush(); app.fill('등록할 과제'); const done = app.submit();
    if (activity === 'edit') await app.action('edit-my', 11);
    else vm.runInContext('isUploadingTaskImage = true', app.context);
    save.resolve({ success: true, assignment_id: 56 }); await done;
    assert.equal(app.window.location.href, '');
    if (activity === 'edit') assert.equal(app.node('taskTitle').value, '원래 과제');
    vm.runInContext('isUploadingTaskImage = false', app.context);
    await app.action('edit-my', 11); app.fill('별도로 수정한 과제');
    await app.submit();
    assert.equal(app.window.location.href, '', 'a blocked earlier create must not redirect a later standalone edit');
  }
});

test('one failed queued create cannot erase a different create that has already succeeded', async () => {
  const first = deferred(), second = deferred();
  const app = setup({ create: payload => payload.title === '첫 과제' ? first.promise : second.promise });
  await flush(); app.fill('첫 과제'); const one = app.submit();
  app.fill('둘째 과제'); const two = app.submit();
  second.resolve({ success: true, assignment_id: 52 }); await two;
  first.resolve({ success: false, error: '첫 저장 실패' }); await one;
  assert.ok(app.html().includes('둘째 과제'));
  assert.match(app.html(), /data-id="52"/);
  assert.ok(!app.html().includes('pending-'));
  assert.ok(app.html().includes('원래 과제'));
  assert.ok(app.html().includes('입력 복원'), 'the failed first draft is retained without replacing the second form generation');
});

test('delete removes immediately and restores only its own row when a concurrent create succeeds', async () => {
  const removal = deferred();
  const app = setup({ delete: () => removal.promise });
  await flush();
  const done = app.action('delete-my', 11);
  assert.ok(!app.html().includes('원래 과제'));
  assert.ok(app.html().includes('삭제 중…'));
  await app.action('delete-my', 11);
  assert.equal(app.calls.delete.length, 1);
  app.fill('동시에 추가한 과제'); await app.submit();
  removal.resolve({ success: false, error: '삭제 실패' }); await done;
  assert.ok(app.html().includes('원래 과제'));
  assert.ok(app.html().includes('동시에 추가한 과제'));
  assert.ok(!app.html().includes('삭제 중…'));
});

test('an older list response cannot erase a row queued after that request began', async () => {
  const list = deferred(), save = deferred();
  const app = setup({ cached: [{ ...original }], get: () => list.promise, create: () => save.promise });
  await flush(); app.fill('먼저 표시할 과제'); const done = app.submit();
  list.resolve([{ ...original }]); await flush();
  assert.ok(app.html().includes('먼저 표시할 과제'));
  save.resolve({ success: true, assignment_id: 62 }); await done;
  assert.match(app.html(), /data-id="62"/);
  assert.equal(app.node('myAssignments')['aria-busy'], 'false');
});

test('the first slow list still contributes existing rows after a newly created row was already confirmed', async () => {
  const list = deferred(), save = deferred();
  const app = setup({ get: () => list.promise, create: () => save.promise });
  await flush(); app.fill('먼저 저장된 새 과제');
  const done = app.submit();
  save.resolve({ success: true, assignment_id: 72 }); await done;
  assert.match(app.html(), /data-id="72"/);
  list.resolve([{ ...original }]); await flush();
  assert.ok(app.html().includes('원래 과제'), 'untouched rows from the slow first response are retained');
  assert.ok(app.html().includes('먼저 저장된 새 과제'), 'a confirmed newer write wins over that older response');
  assert.match(app.html(), /data-id="72"/);
});

test('successful deletion stays removed and confirmed cache never contains temporary rows', async () => {
  const removal = deferred();
  const app = setup({ delete: () => removal.promise });
  await flush();
  const done = app.action('delete-my', 11);
  assert.ok(!app.html().includes('원래 과제'));
  assert.equal(app.calls.cache.length, 0);
  removal.resolve({ success: true }); await done;
  assert.ok(!app.html().includes('원래 과제'));
  assert.ok(!app.html().includes('삭제 중…'));
  assert.equal(app.calls.cache.at(-1).data.length, 0);
});

test('old account and class writes never warm a new scope cache or restore old drafts', async () => {
  for (const next of [{ id: 30 }, { grade: 2, class_number: 3 }]) {
    for (const success of [true, false]) {
      const save = deferred(); const app = setup({ create: () => save.promise });
      await flush(); app.fill('이전 범위 초안'); const writing = app.submit();
      Object.assign(app.user, next);
      save.resolve(success ? { success: true, assignment_id: 81 } : { success: false, error: '실패' });
      await writing;
      assert.ok(!app.html().includes('이전 범위 초안'));
      assert.equal(app.node('taskTitle').value, '');
      assert.equal(app.calls.cache.length, 0);
      assert.equal(app.window.location.href, '', 'a late write from a former scope must not navigate');
    }
  }
});
