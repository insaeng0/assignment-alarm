let filterType = 'grade';
let messages = [];
let messageLoadVersion = 0;
let sendingMessage = false;
API.requireAuth();

async function init() {
  const user = await API.ensureUser();
  if (!user) return;
  API.loadUserInfo();
  document.getElementById('msgTargetGrade').innerHTML = Array.from({ length: 3 }, (_, i) => `<option value="${i + 1}">${i + 1}학년</option>`).join('');
  document.getElementById('msgTargetClass').innerHTML = Array.from({ length: 4 }, (_, i) => `<option value="${i + 1}">${i + 1}반</option>`).join('');
  document.getElementById('msgTargetGrade').value = String(user.grade || 1);
  document.getElementById('msgTargetClass').value = String(user.class_number || 1);
  syncMessageForm();
  API.initNotifications().catch(() => {});
  await loadMessages();
}
function syncMessageForm() {
  const user = API.getUser();
  document.getElementById('messageForm').style.display = user?.is_admin ? 'flex' : 'none';
  document.getElementById('msgTargetGrade').style.display = user?.is_admin ? 'block' : 'none';
  document.getElementById('msgTargetClass').style.display = user?.is_admin && document.getElementById('msgType').value === 'class' ? 'block' : 'none';
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
async function loadMessages() {
  const version = ++messageLoadVersion;
  const container = document.getElementById('messageList');
  updateMessageHeading();
  container.setAttribute('aria-busy', 'true');
  container.innerHTML = '<div class="empty-state">공지사항을 불러오는 중입니다…</div>';
  const data = await API.getMessages(null, null, filterType);
  if (version !== messageLoadVersion) return;
  container.setAttribute('aria-busy', 'false');
  if (!Array.isArray(data)) {
    container.innerHTML = `<div class="empty-state">${API.escapeHTML(data?.error || '공지사항을 불러오지 못했습니다.')}<br><button class="btn btn-secondary btn-sm" type="button" id="retryMessages">다시 시도</button></div>`;
    return;
  }
  messages = data;
  renderMessages();
}
function renderMessages() {
  const user = API.getUser();
  const container = document.getElementById('messageList');
  if (messages.length === 0) { container.innerHTML = '<div class="empty-state">아직 등록된 공지가 없어요.<br>새로운 소식이 생기면 이곳에서 확인할 수 있어요.</div>'; return; }
  container.innerHTML = messages.map((message) => {
    const badge = message.type === 'grade' ? '<span class="msg-badge grade">학년</span>' : '<span class="msg-badge class">반</span>';
    const timestamp = new Date(message.created_at);
    const time = Number.isNaN(timestamp.getTime()) ? '' : timestamp.toLocaleString('ko-KR');
    const canDelete = user && (Number(message.sender_id) === Number(user.id) || user.is_admin);
    const scope = message.type === 'grade' ? `${Number(message.target_grade)}학년` : `${Number(message.target_grade)}학년 ${Number(message.target_class)}반`;
    return `<article class="message-item"><div class="msg-header"><span class="msg-sender">${API.escapeHTML(message.sender_name || '관리자')} ${badge}</span><span class="msg-time">${API.escapeHTML(time)}</span></div><div class="msg-content">${API.escapeHTML(message.content)}</div><div class="msg-time" style="margin-top:6px">${scope}</div>${canDelete ? `<div class="actions" style="margin-top:10px"><button type="button" class="btn btn-danger btn-sm delete-message" data-id="${Number(message.message_id)}">삭제</button></div>` : ''}</article>`;
  }).join('');
}
document.getElementById('sendMsgBtn').addEventListener('click', async () => {
  if (sendingMessage) return;
  const input = document.getElementById('msgContent');
  const content = input.value.trim();
  const type = document.getElementById('msgType').value;
  const user = API.getUser();
  if (!content) { input.focus(); AppUI.toast('공지 내용을 입력해주세요.', true); return; }
  if (content.length > 1000) { AppUI.toast('공지 내용은 1,000자 이하로 입력해주세요.', true); return; }
  if (!user?.is_admin) { AppUI.toast('관리자만 공지를 보낼 수 있습니다.', true); return; }
  const payload = { content, type, target_grade: Number(document.getElementById('msgTargetGrade').value) };
  if (type === 'class') payload.target_class = Number(document.getElementById('msgTargetClass').value);
  const button = document.getElementById('sendMsgBtn');
  sendingMessage = true; button.disabled = true; button.textContent = '보내는 중…'; input.disabled = true;
  try {
    const result = await API.sendMessage(payload);
    if (!result?.success) throw new Error(result?.error || '전송에 실패했습니다. 다시 시도해주세요.');
    input.value = '';
    filterType = type;
    await loadMessages();
    AppUI.toast('공지사항을 보냈습니다.');
    API.refreshNotifications().catch(() => {});
  } catch (error) { AppUI.toast(error.message || '전송에 실패했습니다.', true); }
  finally { sendingMessage = false; button.disabled = false; input.disabled = false; button.textContent = '보내기'; }
});
document.getElementById('messageList').addEventListener('click', async (event) => {
  if (event.target.id === 'retryMessages') { await loadMessages(); return; }
  const button = event.target.closest('.delete-message');
  if (!button || button.disabled || !confirm('이 공지사항을 삭제할까요? 삭제하면 되돌릴 수 없습니다.')) return;
  button.disabled = true;
  const result = await API.deleteMessage(Number(button.dataset.id));
  if (!result?.success) { button.disabled = false; AppUI.toast(result?.error || '삭제에 실패했습니다.', true); return; }
  await loadMessages();
  AppUI.toast('공지사항이 삭제되었습니다.');
  API.refreshNotifications().catch(() => {});
});
document.getElementById('msgType').addEventListener('change', (event) => { syncMessageForm(); filterType = event.target.value; loadMessages(); });
for (const [id, type] of [['showGradeMsg', 'grade'], ['showClassMsg', 'class']]) {
  document.getElementById(id).addEventListener('click', () => {
    if (filterType === type) return;
    filterType = type;
    document.getElementById('msgType').value = type;
    syncMessageForm();
    loadMessages();
  });
}
init().catch(() => AppUI.toast('공지사항을 불러오지 못했습니다. 새로고침해주세요.', true));
