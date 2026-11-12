/* AI 챗봇 원본 보관. 기능을 재도입하기 전까지 실행 및 API 호출을 하지 않습니다.
const chatbotState = {
  history: [],
  sending: false,
  config: null,
  user: null
};

API.requireAuth();

function getChatHistoryKey(userId) {
  return `assignment-chatbot-history-${userId}`;
}

function loadStoredHistory(userId) {
  if (!userId) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(getChatHistoryKey(userId)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
      .map((item) => ({
        role: item.role,
        content: String(item.content || '').trim()
      }))
      .filter((item) => item.content)
      .slice(-20);
  } catch {
    return [];
  }
}

function saveStoredHistory() {
  if (!chatbotState.user?.id) return;
  localStorage.setItem(
    getChatHistoryKey(chatbotState.user.id),
    JSON.stringify(chatbotState.history.slice(-20))
  );
}

function formatChatText(value) {
  return API.escapeHTML(String(value || '')).replace(/\n/g, '<br>');
}

function isChatbotEnabled() {
  return Boolean(chatbotState.config?.chatbotEnabled);
}

function syncComposerState() {
  const input = document.getElementById('chatbotInput');
  const sendBtn = document.getElementById('chatbotSendBtn');
  const suggestionButtons = document.querySelectorAll('.chatbot-suggestion');
  const disabled = chatbotState.sending || !isChatbotEnabled();

  input.disabled = disabled;
  sendBtn.disabled = disabled;
  sendBtn.textContent = chatbotState.sending ? '답변 작성 중...' : '질문 보내기';
  suggestionButtons.forEach((button) => {
    button.disabled = disabled;
  });
}

function renderStatus() {
  const status = document.getElementById('chatbotStatus');
  if (!isChatbotEnabled()) {
    status.className = 'chatbot-status disabled';
    status.textContent = '챗봇이 현재 비활성화되어 있습니다.';
    return;
  }

  status.className = 'chatbot-status enabled';
  status.textContent = '챗봇이 활성화되어 있습니다.';
}

function renderMessages() {
  const container = document.getElementById('chatbotMessages');
  const rows = chatbotState.history.map((item) => `
    <div class="chatbot-row ${item.role}">
      <div class="chatbot-meta">${item.role === 'assistant' ? 'AI 챗봇' : '나'}</div>
      <div class="chatbot-bubble ${item.role}">${formatChatText(item.content)}</div>
    </div>
  `);

  if (chatbotState.sending) {
    rows.push(`
      <div class="chatbot-row assistant">
        <div class="chatbot-meta">AI 챗봇</div>
        <div class="chatbot-bubble assistant chatbot-typing">답변 작성 중...</div>
      </div>
    `);
  }

  container.innerHTML = rows.length > 0
    ? rows.join('')
    : '<div class="chatbot-empty">대화를 시작하면 여기에 답변이 표시됩니다.</div>';

  container.scrollTop = container.scrollHeight;
  saveStoredHistory();
}

async function submitChat(prefilledPrompt = null) {
  if (chatbotState.sending || !isChatbotEnabled()) return;

  const input = document.getElementById('chatbotInput');
  const message = String(prefilledPrompt || input.value || '').trim();
  if (!message) {
    input.focus();
    return;
  }

  const historyBeforeRequest = chatbotState.history.slice(-8);
  chatbotState.history.push({ role: 'user', content: message });
  chatbotState.sending = true;
  input.value = '';
  syncComposerState();
  renderMessages();

  try {
    const response = await API.sendChatMessage(message, historyBeforeRequest);
    if (!response?.success || !response?.reply) {
      chatbotState.history.push({
        role: 'assistant',
        content: response?.error || '챗봇 응답을 가져오지 못했습니다.'
      });
    } else {
      chatbotState.history.push({
        role: 'assistant',
        content: response.reply
      });
    }
  } catch {
    chatbotState.history.push({
      role: 'assistant',
      content: '챗봇 응답 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.'
    });
  } finally {
    chatbotState.sending = false;
    syncComposerState();
    renderMessages();
    input.focus();
  }
}

async function init() {
  const user = await API.ensureUser();
  if (!user) return;

  chatbotState.user = user;
  chatbotState.history = loadStoredHistory(user.id);

  API.loadUserInfo();
  chatbotState.config = await API.publicConfig();
  renderStatus();
  renderMessages();
  syncComposerState();
  API.initNotifications().catch(() => {});

  document.getElementById('chatbotForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await submitChat();
  });

  document.getElementById('chatbotSuggestions').addEventListener('click', async (event) => {
    const button = event.target.closest('.chatbot-suggestion');
    if (!button) return;
    await submitChat(button.dataset.prompt || '');
  });

  document.getElementById('clearConversationBtn').addEventListener('click', () => {
    chatbotState.history = [];
    saveStoredHistory();
    renderMessages();
    document.getElementById('chatbotInput').focus();
  });
}

init();

*/
