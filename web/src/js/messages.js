let filterType = 'grade';
let messages = [];
const messagePages = new Map();
const messageLoads = new Map();
const messageOperations = new Map();
let temporaryMessageId = -1;
let draftRevision = 0;
let formUserId = null;
let messageScope = null;
function currentMessageScope() {
  const user = API.getUser();
  return user ? JSON.stringify([user.id, user.grade, user.class_number, user.is_admin, user.can_complete_assignments]) : '';
}
function syncMessageScope() {
  const next = currentMessageScope();
  if (messageScope === null) { messageScope = next; return next; }
  if (messageScope !== next) {
    messagePages.clear(); messageLoads.clear(); messageOperations.clear(); messages = [];
    formUserId = null; messageScope = next; draftRevision++;
    document.getElementById('msgContent').value = '';
  }
  return next;
}
API.requireAuth();

function prepareMessageForm(user) {
  syncMessageScope();
  if (formUserId !== user.id) {
    document.getElementById('msgTargetGrade').innerHTML = Array.from({ length: 3 }, (_, i) => `<option value="${i + 1}">${i + 1}학년</option>`).join('');
    document.getElementById('msgTargetClass').innerHTML = Array.from({ length: 4 }, (_, i) => `<option value="${i + 1}">${i + 1}반</option>`).join('');
    document.getElementById('msgTargetGrade').value = String(user.grade || 1);
    document.getElementById('msgTargetClass').value = String(user.class_number || 1);
    formUserId = user.id;
  }
  syncMessageForm();
}
async function init() {
  const cached = API.getUser();
  if (cached) { prepareMessageForm(cached); API.loadUserInfo(); showCachedMessages(); }
  const user = await API.ensureUser();
  if (!user) return;
  API.loadUserInfo(); prepareMessageForm(user);
  API.initNotifications().catch(() => {});
  await loadMessages();
}
function syncMessageForm() {
  const user = API.getUser();
  document.getElementById('messageForm').style.display = user ? 'flex' : 'none';
  document.getElementById('msgTargetGrade').style.display = user?.is_admin ? 'block' : 'none';
  document.getElementById('msgTargetClass').style.display = user?.is_admin && document.getElementById('msgType').value === 'class' ? 'block' : 'none';
  document.getElementById('msgContent').placeholder = user?.is_admin ? '함께 나눌 소식을 적어주세요.' : `${user?.grade}학년${document.getElementById('msgType').value === 'class' ? ' ' + user?.class_number + '반' : ' 전체'}에 전할 소식을 적어주세요.`;
}
function updateMessageHeading() {
  const user = API.getUser();
  const scope = user?.is_admin ? '전체' : user ? filterType === 'grade' ? `${user.grade}학년` : `${user.grade}학년 ${user.class_number}반` : '';
  document.getElementById('messageTitle').textContent = `${filterType === 'grade' ? '학년 공지' : '반 공지'}${scope ? ' · ' + scope : ''}`;
  for (const [id, type] of [['showGradeMsg', 'grade'], ['showClassMsg', 'class']]) {
    const button = document.getElementById(id);
    button.classList.toggle('active', filterType === type);
    button.setAttribute('aria-pressed', String(filterType === type));
  }
}
function visibleMessages() {
  syncMessageScope();
  const userId = API.getUser()?.id;
  let rows = (messagePages.get(filterType) || []).slice();
  for (const operation of messageOperations.values()) {
    if (operation.userId !== userId || operation.row.type !== filterType) continue;
    rows = rows.filter(row => Number(row.message_id) !== Number(operation.row.message_id));
    if (operation.kind === 'create') rows.unshift({ ...operation.row, saving: operation.status === 'pending' });
  }
  return rows;
}
function showCachedMessages() {
  const cached = API.getCachedData?.('/api/messages?type=' + filterType);
  if (!messagePages.has(filterType) && Array.isArray(cached)) messagePages.set(filterType, cached);
  updateMessageHeading(); renderMessages();
}
async function loadMessages() {
  const scope = syncMessageScope();
  const type = filterType;
  const version = (messageLoads.get(type) || 0) + 1;
  messageLoads.set(type, version);
  showCachedMessages();
  const container = document.getElementById('messageList');
  container.setAttribute('aria-busy', 'true');
  if (!messagePages.has(type) && !visibleMessages().length) container.innerHTML = '<div class="empty-state">공지사항을 불러오는 중입니다…</div>';
  const data = await API.getMessages(null, null, type);
  if (scope !== currentMessageScope()) { syncMessageScope(); renderMessages(); return; }
  if (version !== messageLoads.get(type)) return;
  if (filterType === type) container.setAttribute('aria-busy', 'false');
  if (!Array.isArray(data)) {
    if (filterType === type && !visibleMessages().length) container.innerHTML = `<div class="empty-state">${API.escapeHTML(data?.error || '공지사항을 불러오지 못했습니다.')}<br><button class="btn btn-secondary btn-sm" type="button" id="retryMessages">다시 시도</button></div>`;
    return;
  }
  messagePages.set(type, data);
  for (const [key, operation] of messageOperations) {
    if (operation.row.type !== type || operation.status !== 'confirmed') continue;
    const exists = data.some(row => Number(row.message_id) === Number(operation.row.message_id));
    if ((operation.kind === 'create' && exists) || (operation.kind === 'delete' && !exists)) messageOperations.delete(key);
  }
  if (filterType === type) renderMessages();
}
function renderMessages() {
  const user = API.getUser();
  const container = document.getElementById('messageList');
  messages = visibleMessages();
  if (!messages.length) { container.innerHTML = '<div class="empty-state">아직 등록된 공지가 없어요.<br>새로운 소식이 생기면 이곳에서 확인할 수 있어요.</div>'; return; }
  container.innerHTML = messages.map(message => {
    const badge = message.type === 'grade' ? '<span class="msg-badge grade">학년</span>' : '<span class="msg-badge class">반</span>';
    const time = API.formatDateTime(message.created_at);
    const canDelete = !message.saving && user && (Number(message.sender_id) === Number(user.id) || user.is_admin);
    const scope = message.type === 'grade' ? `${Number(message.target_grade)}학년` : `${Number(message.target_grade)}학년 ${Number(message.target_class)}반`;
    return `<article class="message-item"${message.saving ? ' aria-busy="true"' : ''}><div class="msg-header"><span class="msg-sender">${API.escapeHTML(message.sender_name || '학교 계정')} ${badge}</span><span class="msg-time">${message.saving ? '저장 중…' : API.escapeHTML(time)}</span></div><div class="msg-content">${API.escapeHTML(message.content)}</div><div class="msg-time" style="margin-top:6px">${scope}</div>${canDelete ? `<div class="actions" style="margin-top:10px"><button type="button" class="btn btn-danger btn-sm delete-message" data-id="${Number(message.message_id)}">삭제</button></div>` : ''}</article>`;
  }).join('');
}
document.getElementById('sendMsgBtn').addEventListener('click', async () => {
  const scope = syncMessageScope();
  const input = document.getElementById('msgContent');
  const content = input.value.trim(), type = document.getElementById('msgType').value, user = API.getUser();
  if (!user) return;
  if (!content) { input.focus(); AppUI.toast('공지 내용을 입력해주세요.', true); return; }
  if (content.length > 1000 || !['grade', 'class'].includes(type)) { AppUI.toast('공지 유형과 1,000자 이내의 내용을 확인해주세요.', true); return; }
  const payload = { content, type, target_grade: user.is_admin ? Number(document.getElementById('msgTargetGrade').value) : Number(user.grade) };
  if (type === 'class') payload.target_class = user.is_admin ? Number(document.getElementById('msgTargetClass').value) : Number(user.class_number);
  const id = temporaryMessageId--;
  const operation = { kind: 'create', userId: user.id, status: 'pending', row: { ...payload, message_id: id, sender_id: user.id, sender_name: user.name, created_at: new Date().toISOString() } };
  messageOperations.set(id, operation);
  input.value = ''; const revision = ++draftRevision;
  filterType = type; updateMessageHeading(); renderMessages();
  try {
    const result = await API.sendMessage(payload);
    if (!result?.success || !Number.isSafeInteger(Number(result.message_id)) || Number(result.message_id) < 1) throw new Error(result?.error || '공지 저장 결과를 확인하지 못했습니다. 목록을 확인한 뒤 다시 시도해주세요.');
    if (scope !== currentMessageScope()) { syncMessageScope(); renderMessages(); return; }
    operation.status = 'confirmed'; operation.row.message_id = Number(result.message_id);
    renderMessages(); AppUI.toast('공지사항을 보냈습니다.');
    void loadMessages(); API.refreshNotifications().catch(() => {});
  } catch (error) {
    messageOperations.delete(id);
    if (scope !== currentMessageScope()) { syncMessageScope(); renderMessages(); return; }
    if (draftRevision === revision && !input.value) { input.value = content; ++draftRevision; }
    renderMessages(); AppUI.toast(error.message || '공지 저장에 실패했습니다.', true);
  }
});
document.getElementById('messageList').addEventListener('click', async event => {
  const scope = syncMessageScope();
  if (event.target.id === 'retryMessages') { await loadMessages(); return; }
  const button = event.target.closest('.delete-message');
  if (!button || button.disabled) return;
  const id = Number(button.dataset.id), user = API.getUser(), row = messages.find(message => Number(message.message_id) === id);
  if (!row || row.saving || !user || (!user.is_admin && Number(row.sender_id) !== Number(user.id)) || messageOperations.get(id)?.kind === 'delete') return;
  if (!confirm('이 공지사항을 삭제할까요? 삭제하면 되돌릴 수 없습니다.')) return;
  const operation = { kind: 'delete', userId: user.id, status: 'pending', row };
  messageOperations.set(id, operation); renderMessages();
  try {
    const result = await API.deleteMessage(id);
    if (!result?.success) throw new Error(result?.error || '삭제에 실패했습니다.');
    operation.status = 'confirmed';
    for (const [key, other] of messageOperations) if (other !== operation && other.kind === 'create' && Number(other.row.message_id) === id) messageOperations.delete(key);
    if (scope !== currentMessageScope()) { syncMessageScope(); renderMessages(); return; }
    renderMessages(); AppUI.toast('공지사항이 삭제되었습니다.');
    void loadMessages(); API.refreshNotifications().catch(() => {});
  } catch (error) {
    if (messageOperations.get(id) === operation) messageOperations.delete(id);
    if (scope !== currentMessageScope()) { syncMessageScope(); renderMessages(); return; }
    const base = messagePages.get(row.type) || [];
    if (!base.some(message => Number(message.message_id) === id)) messagePages.set(row.type, [row, ...base]);
    renderMessages(); AppUI.toast(error.message || '삭제에 실패했습니다.', true);
  }
});
document.getElementById('msgContent').addEventListener('input', () => { draftRevision++; });
document.getElementById('msgType').addEventListener('change', event => { draftRevision++; syncMessageForm(); filterType = event.target.value; void loadMessages(); });
for (const [id, type] of [['showGradeMsg', 'grade'], ['showClassMsg', 'class']]) document.getElementById(id).addEventListener('click', () => {
  if (filterType === type) return;
  draftRevision++; filterType = type; document.getElementById('msgType').value = type;
  syncMessageForm(); void loadMessages();
});
init().catch(() => AppUI.toast('공지사항을 불러오지 못했습니다. 새로고침해주세요.', true));
