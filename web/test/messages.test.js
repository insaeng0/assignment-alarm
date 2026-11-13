const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function noticePage(options = {}) {
  const nodes = new Map(), handlers = new Map(), toasts = [], sent = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: id === 'msgType' ? 'grade' : '', style: {}, innerHTML: '', textContent: '', disabled: false, setAttribute() {}, focus() {}, classList: { toggle() {} }, addEventListener(kind, fn) { handlers.set(id + ':' + kind, fn); } });
    return nodes.get(id);
  };
  let user = options.user || { id: 1, name: '학생', grade: 1, class_number: 2, is_admin: false };
  const rows = options.rows || [];
  const API = { requireAuth() {}, getUser: () => user, ensureUser: options.ensureUser || (async () => null), loadUserInfo() {}, initNotifications: async () => {}, refreshNotifications: async () => {}, getCachedData: () => rows,
    escapeHTML: text => String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    formatDateTime: value => '한국 시각 ' + value,
    getMessages: options.getMessages || (async () => rows),
    sendMessage: payload => { sent.push(payload); return options.send ? options.send(payload) : Promise.resolve({ success: true, message_id: 70 }); },
    deleteMessage: options.remove || (async () => ({ success: true })) };
  const context = vm.createContext({ API, AppUI: { toast: (...args) => toasts.push(args) }, document: { getElementById: node }, confirm: () => true, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/js/messages.js'), 'utf8'), context);
  return { context, nodes, handlers, sent, toasts, user: value => { user = value; }, read: expr => vm.runInContext(expr, context), node };
}
const row = (id, content = '공지' + id) => ({ message_id: id, content, type: 'grade', target_grade: 1, target_class: null, sender_id: 1, sender_name: '학생', created_at: '2026-11-12T00:00:00Z' });
test('a student sees the posting form and their notice appears before the server responds', async () => {
  const save = deferred(); const page = noticePage({ send: () => save.promise });
  page.node('msgContent').value = '내가 쓴 공지'; page.node('msgTargetGrade').value = '3';
  const operation = page.handlers.get('sendMsgBtn:click')();
  assert.equal(page.node('messageForm').style.display, 'flex');
  assert.equal(page.node('msgTargetGrade').style.display, 'none');
  assert.equal(page.node('msgContent').value, '');
  assert.ok(page.node('messageList').innerHTML.includes('내가 쓴 공지'));
  assert.ok(page.node('messageList').innerHTML.includes('저장 중'));
  assert.equal(page.sent[0].target_grade, 1);
  save.resolve({ success: true, message_id: 70 }); await operation;
  assert.equal(page.read('messages[0].message_id'), 70);
  assert.ok(!page.node('messageList').innerHTML.includes('저장 중'));
});
test('failed notice creation restores only an untouched draft and preserves newer typing', async () => {
  for (const typing of [false, true]) {
    const save = deferred(); const page = noticePage({ send: () => save.promise });
    page.node('msgContent').value = '실패할 글';
    const operation = page.handlers.get('sendMsgBtn:click')();
    if (typing) { page.node('msgContent').value = '다음에 쓸 글'; page.handlers.get('msgContent:input')(); }
    save.resolve({ success: false, error: '서버 오류' }); await operation;
    assert.equal(page.node('msgContent').value, typing ? '다음에 쓸 글' : '실패할 글');
    assert.equal(page.read('messages.length'), 0);
  }
});
test('a pending notice deletion stays hidden when an older list arrives and rolls back without losing another deletion', async () => {
  const a = deferred(), b = deferred();
  const page = noticePage({ rows: [row(1, '첫 번째'), row(2, '두 번째')], remove: id => id === 1 ? a.promise : b.promise });
  const click = id => page.handlers.get('messageList:click')({ target: { closest: () => ({ dataset: { id: String(id) }, disabled: false }) } });
  const first = click(1), second = click(2);
  assert.equal(page.read('messages.length'), 0);
  await page.read('loadMessages()'); assert.equal(page.read('messages.length'), 0);
  b.resolve({ success: true }); await second;
  a.resolve({ success: false, error: '삭제 실패' }); await first;
  assert.deepEqual(JSON.parse(page.read('JSON.stringify(messages.map(x=>x.message_id))')), [1]);
});
test('a confirmed new notice is not erased by a slower initial read and pending rows cannot be deleted', async () => {
  const save = deferred(), load = deferred(); let deletes = 0;
  const page = noticePage({ send: () => save.promise, getMessages: () => load.promise, remove: async () => { deletes++; return { success: true }; } });
  const firstRead = page.read('loadMessages()');
  page.node('msgContent').value = '새 공지'; const write = page.handlers.get('sendMsgBtn:click')();
  const temporary = page.read('messages[0].message_id');
  await page.handlers.get('messageList:click')({ target: { closest: () => ({ dataset: { id: String(temporary) } }) } });
  assert.equal(deletes, 0);
  save.resolve({ success: true, message_id: 90 }); await write;
  load.resolve([row(8, '기존 공지')]); await firstRead; await new Promise(setImmediate);
  assert.ok(page.node('messageList').innerHTML.includes('새 공지'));
  assert.ok(page.node('messageList').innerHTML.includes('기존 공지'));
});
test('cached notices render before identity revalidation finishes', async () => {
  const identity = deferred(); let reads = 0;
  const page = noticePage({ rows: [row(2, '최근 공지')], ensureUser: () => identity.promise, getMessages: async () => { reads++; return []; } });
  assert.ok(page.node('messageList').innerHTML.includes('최근 공지')); assert.equal(reads, 0);
  identity.resolve(null); await new Promise(setImmediate);
});

test('late old-user or old-class responses never render or restore drafts in a new scope', async () => {
  for (const nextUser of [{ id: 2, grade: 1, class_number: 2, is_admin: false }, { id: 1, grade: 2, class_number: 3, is_admin: false }]) {
    const save = deferred(), load = deferred();
    const page = noticePage({ rows: [row(1, '이전 반 공지')], send: () => save.promise, getMessages: () => load.promise });
    const reading = page.read('loadMessages()');
    page.node('msgContent').value = '이전 초안'; const writing = page.handlers.get('sendMsgBtn:click')();
    page.user(nextUser);
    load.resolve([row(3, '늦게 온 이전 공지')]); await reading;
    save.resolve({ success: false, error: '늦은 실패' }); await writing;
    assert.equal(page.read('messages.length'), 0);
    assert.equal(page.node('msgContent').value, '');
    assert.ok(!page.node('messageList').innerHTML.includes('이전'));
  }
});
