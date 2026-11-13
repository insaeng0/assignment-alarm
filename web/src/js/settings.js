API.initTheme();
    API.requireAuth();
    const adminLoadVersions = { assignment: 0, message: 0, user: 0 };

      const adminSettingsState = {
        pageSize: 10,
        assignmentGrade: 'all',
        assignmentClass: 'all',
      assignmentPage: 1,
      assignmentTotal: 0,
      messageType: 'grade',
      messageGrade: 'all',
      messageClass: 'all',
      messagePage: 1,
      messageTotal: 0,
      userPage: 1,
      userTotal: 0,
      assignments: [],
      messages: [],
        users: [],
        assignmentStatusById: {},
        assignmentStatusLoading: {},
        assignmentStatusOpen: {},
        assignmentStatusFilterById: {},
        adminLoaded: {
          assignment: false,
          message: false,
          user: false
        },
        adminLoading: {
          assignment: null,
          message: null,
          user: null
        }
      };

    let alarmOperation = null;
    let adminModeOperation = null;
    const adminUserUpdates = new Map();
    const adminUserDrafts = new Map();
    const adminDeletes = { assignment: new Map(), message: new Map(), user: new Map() };
    const adminListFields = {
      assignment: { items: 'assignments', id: 'assignment_id', total: 'assignmentTotal', page: 'assignmentPage', pager: 'adminAssignmentPager' },
      message: { items: 'messages', id: 'message_id', total: 'messageTotal', page: 'messagePage', pager: 'adminMessagePager' },
      user: { items: 'users', id: 'user_id', total: 'userTotal', page: 'userPage', pager: 'adminUserPager' }
    };
    let lastSettingsScope = null;
    function settingsScope() {
      const user = API.getUser();
      let backend = '';
      try { backend = API.getAuthRealm?.() || API.getApiOrigin?.() || ''; } catch {}
      return JSON.stringify([backend, user?.id, user?.grade, user?.class_number, user?.is_admin, user?.can_complete_assignments]);
    }
    function syncSettingsScope() {
      const next = settingsScope();
      if (lastSettingsScope === next) return next;
      const previous = lastSettingsScope;
      lastSettingsScope = next;
      if (previous === null) return next;
      adminUserUpdates.clear();
      adminUserDrafts.clear();
      for (const kind of ['assignment', 'message', 'user']) {
        const fields = adminListFields[kind];
        adminDeletes[kind].clear();
        adminLoadVersions[kind] += 1;
        adminSettingsState[fields.items] = [];
        adminSettingsState[fields.total] = 0;
        adminSettingsState.adminLoaded[kind] = false;
        document.getElementById(fields.pager).innerHTML = '';
        document.getElementById({ assignment: 'adminAssignmentList', message: 'adminMessageList', user: 'adminUserList' }[kind]).innerHTML = '';
      }
      for (const field of ['assignmentStatusById', 'assignmentStatusLoading', 'assignmentStatusOpen', 'assignmentStatusFilterById']) adminSettingsState[field] = {};
      for (const id of ['adminAssignmentSection', 'adminMessageSection', 'adminUserSection']) document.getElementById(id).style.display = API.normalizeFlag(API.getUser()?.is_admin) ? 'block' : 'none';
      if (alarmOperation && !sameAccount(alarmOperation.accountId)) {
        alarmOperation = null;
        document.getElementById('alarmToggle').disabled = false;
        document.getElementById('alarmToggle').setAttribute('aria-busy', 'false');
      }
      return next;
    }

    function sameAccount(accountId) { return Number(API.getUser()?.id) === Number(accountId); }
    function canStartAdminOperation() {
      if (!API.normalizeFlag(API.getUser()?.is_admin)) return false;
      const count = adminUserUpdates.size + Object.values(adminDeletes).reduce((sum, pending) => sum + pending.size, 0);
      if (count < 20) return true;
      AppUI.toast('저장 중인 작업을 마친 뒤 다시 시도해주세요.', true);
      return false;
    }
    function adminViewKey(kind) {
      const state = adminSettingsState;
      if (kind === 'assignment') return JSON.stringify([state.assignmentPage, state.assignmentGrade, state.assignmentClass]);
      if (kind === 'message') return JSON.stringify([state.messagePage, state.messageType, state.messageGrade, state.messageClass]);
      return String(state.userPage);
    }
    function renderAdminList(kind) {
      ({ assignment: renderAdminAssignments, message: renderAdminMessages, user: renderAdminUsers })[kind]();
      const fields = adminListFields[kind];
      renderPagination(fields.pager, kind, adminSettingsState[fields.page], adminSettingsState[fields.total], adminSettingsState.pageSize);
    }
    function overlayAdminResponse(kind, response) {
      const fields = adminListFields[kind];
      const pending = adminDeletes[kind];
      const key = adminViewKey(kind);
      let hidden = 0;
      for (const operation of pending.values()) operation.totalViewKey = null;
      const items = response.items.filter(record => {
        const operation = pending.get(Number(record[fields.id]));
        if (!operation) return true;
        operation.totalViewKey = key;
        hidden += 1;
        return false;
      }).map(record => {
        const operation = kind === 'user' ? adminUserUpdates.get(Number(record.user_id)) : null;
        return operation ? { ...record, ...operation.payload } : record;
      });
      // Subtract only records present in this response: a server read may have
      // already observed a delete whose write response has not arrived yet.
      return { items, total: Math.max(0, (Number(response.total) || 0) - hidden) };
    }
    function reloadAdminInBackground(kind) {
      const loader = { assignment: loadAdminAssignments, message: loadAdminMessages, user: loadAdminUsers }[kind];
      loader({ keepVisible: true }).catch(() => AppUI.toast('변경은 저장됐지만 목록을 새로고침하지 못했습니다.', true));
    }
    function showCachedAdminList(kind, params) {
      syncSettingsScope();
      if (typeof API.getCachedData !== 'function' || !API.normalizeFlag(API.getUser()?.is_admin)) return false;
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) if (value) query.set(key, String(value));
      const endpoint = { assignment: 'assignments', message: 'messages', user: 'users' }[kind];
      let cached;
      try { cached = API.getCachedData(`/api/admin/${endpoint}?${query}`); } catch { return false; }
      if (!Array.isArray(cached?.items)) return false;
      const visible = overlayAdminResponse(kind, cached);
      const fields = adminListFields[kind];
      adminSettingsState[fields.items] = visible.items;
      adminSettingsState[fields.total] = visible.total;
      renderAdminList(kind);
      return true;
    }
    function reconcileDeletedUserContent(userId) {
      for (const [kind, owner] of [['assignment', 'created_by'], ['message', 'sender_id']]) {
        const fields = adminListFields[kind];
        const records = adminSettingsState[fields.items];
        const remaining = records.filter(record => Number(record[owner]) !== userId);
        adminSettingsState[fields.items] = remaining;
        adminSettingsState[fields.total] = Math.max(0, adminSettingsState[fields.total] - (records.length - remaining.length));
        adminSettingsState.adminLoaded[kind] = false;
        // A confirmed account cascade is authoritative even if an individual
        // delete response is still pending. It must not resurrect that content.
        for (const [id, operation] of adminDeletes[kind]) {
          if (Number(operation.record[owner]) === userId) adminDeletes[kind].delete(id);
        }
        adminLoadVersions[kind] += 1;
        renderAdminList(kind);
        const panel = document.getElementById(kind === 'assignment' ? 'adminAssignmentPanel' : 'adminMessagePanel');
        if (panel?.classList.contains('show')) reloadAdminInBackground(kind);
      }
      API.refreshNotifications().catch(() => {});
    }

    async function deleteAdminRecord(kind, id, request) {
      syncSettingsScope();
      if (!canStartAdminOperation() || adminDeletes[kind].has(id) || (kind === 'user' && adminUserUpdates.has(id))) return;
      const fields = adminListFields[kind];
      const index = adminSettingsState[fields.items].findIndex(record => Number(record[fields.id]) === id);
      if (index < 0) return;
      const record = adminSettingsState[fields.items][index];
      if (kind === 'user' && API.normalizeFlag(record.is_admin)) return;
      const viewKey = adminViewKey(kind);
      const existing = [...adminDeletes[kind].values()].find(operation => operation.viewKey === viewKey);
      const order = existing?.order || adminSettingsState[fields.items].map(item => Number(item[fields.id]));
      const operation = { record, index, order, accountId: API.getUser().id, viewKey, totalViewKey: viewKey };
      adminDeletes[kind].set(id, operation);
      adminLoadVersions[kind] += 1;
      adminSettingsState[fields.items] = adminSettingsState[fields.items].filter(item => Number(item[fields.id]) !== id);
      adminSettingsState[fields.total] = Math.max(0, adminSettingsState[fields.total] - 1);
      renderAdminList(kind);
      try {
        const result = await request(id);
        if (!result?.success) throw new Error(result?.error || '삭제하지 못했습니다.');
        syncSettingsScope();
        if (adminDeletes[kind].get(id) !== operation) return;
        adminDeletes[kind].delete(id);
        adminLoadVersions[kind] += 1;
        if (!sameAccount(operation.accountId)) return;
        if (kind === 'user') {
          adminUserDrafts.delete(id);
          reconcileDeletedUserContent(id);
        }
        AppUI.toast('삭제했습니다.');
        reloadAdminInBackground(kind);
        if (kind !== 'user') API.refreshNotifications().catch(() => {});
      } catch (error) {
        syncSettingsScope();
        if (adminDeletes[kind].get(id) !== operation) return;
        adminDeletes[kind].delete(id);
        adminLoadVersions[kind] += 1;
        if (!sameAccount(operation.accountId)) return;
        const records = adminSettingsState[fields.items];
        if (adminViewKey(kind) === operation.viewKey && !records.some(item => Number(item[fields.id]) === id)) {
          const rank = operation.order.indexOf(id);
          const next = operation.order.slice(rank + 1).find(candidate => records.some(item => Number(item[fields.id]) === candidate));
          const position = next === undefined ? records.length : records.findIndex(item => Number(item[fields.id]) === next);
          records.splice(position, 0, operation.record);
        }
        if (operation.totalViewKey === adminViewKey(kind)) adminSettingsState[fields.total] += 1;
        renderAdminList(kind);
        AppUI.toast((error?.message || '삭제하지 못했습니다.') + ' 화면을 원래대로 돌렸습니다.', true);
      }
    }

    async function saveAdminUser(userId, payload) {
      syncSettingsScope();
      if (!canStartAdminOperation() || adminUserUpdates.has(userId) || adminDeletes.user.has(userId)) return;
      const index = adminSettingsState.users.findIndex(user => Number(user.user_id) === userId);
      if (index < 0) return;
      if (!Number.isInteger(payload.grade) || payload.grade < 1 || payload.grade > 3 || !Number.isInteger(payload.class_number) || payload.class_number < 1 || payload.class_number > 4) {
        AppUI.toast('학년과 반을 확인해주세요.', true);
        return;
      }
      const operation = { before: adminSettingsState.users[index], payload, accountId: API.getUser().id };
      adminUserUpdates.set(userId, operation);
      adminLoadVersions.user += 1;
      adminSettingsState.users[index] = { ...operation.before, ...payload };
      renderAdminUsers();
      try {
        const result = await API.updateAdminUser(userId, payload);
        if (!result?.success) throw new Error(result?.error || '사용자 정보를 저장하지 못했습니다.');
        syncSettingsScope();
        if (adminUserUpdates.get(userId) !== operation) return;
        adminUserUpdates.delete(userId);
        adminUserDrafts.delete(userId);
        adminLoadVersions.user += 1;
        if (!sameAccount(operation.accountId)) return;
        if (Number(API.getUser()?.id) === userId) {
          API.setUser({ ...API.getUser(), ...payload });
          syncSettingsScope();
          loadProfile(API.getUser()).catch(() => {});
        }
        renderAdminUsers();
        AppUI.toast('사용자 정보를 저장했습니다.');
        reloadAdminInBackground('user');
      } catch (error) {
        syncSettingsScope();
        if (adminUserUpdates.get(userId) !== operation) return;
        adminUserUpdates.delete(userId);
        adminUserDrafts.delete(userId);
        adminLoadVersions.user += 1;
        if (!sameAccount(operation.accountId)) return;
        adminSettingsState.users = adminSettingsState.users.map(user => {
          if (Number(user.user_id) !== userId) return user;
          const restored = { ...user };
          for (const field of ['grade', 'class_number']) {
            if (Number(user[field]) === payload[field]) restored[field] = operation.before[field];
          }
          return restored;
        });
        renderAdminUsers();
        AppUI.toast((error?.message || '사용자 정보를 저장하지 못했습니다.') + ' 변경 내용을 되돌렸습니다.', true);
      }
    }

    async function init() {
      syncSettingsScope();
      const cached = API.getUser();
      if (cached) {
        loadProfile(cached).catch(() => {});
        if (API.normalizeFlag(cached.is_admin)) {
          document.getElementById('adminAssignmentSection').style.display = 'block';
          document.getElementById('adminMessageSection').style.display = 'block';
          document.getElementById('adminUserSection').style.display = 'block';
          initAdminSelectors();
          showCachedAdminList('assignment', {
            page: adminSettingsState.assignmentPage, pageSize: adminSettingsState.pageSize,
            grade: adminSettingsState.assignmentGrade, class_number: adminSettingsState.assignmentClass
          });
        }
      }
      const user = await API.ensureUser();
      if (!user) return;
      syncSettingsScope();
      API.loadUserInfo();
      API.initNotifications().catch(() => {});
      await loadProfile(user);
      if (!API.normalizeFlag(user.is_admin)) {
        for (const id of ['adminAssignmentSection', 'adminMessageSection', 'adminUserSection']) document.getElementById(id).style.display = 'none';
        for (const kind of ['assignment', 'message', 'user']) adminLoadVersions[kind] += 1;
      }
        if (user.is_admin) {
          document.getElementById('adminAssignmentSection').style.display = 'block';
          document.getElementById('adminMessageSection').style.display = 'block';
          document.getElementById('adminUserSection').style.display = 'block';
          initAdminSelectors();
          await ensureAdminSectionLoaded('assignment');
        }
      }

      async function ensureAdminSectionLoaded(kind, { force = false } = {}) {
        const loaderMap = {
          assignment: loadAdminAssignments,
          message: loadAdminMessages,
          user: loadAdminUsers
        };
        const loader = loaderMap[kind];
        if (!loader) return;
        if (!force && adminSettingsState.adminLoaded[kind]) return;
        if (adminSettingsState.adminLoading[kind]) return adminSettingsState.adminLoading[kind];

        adminSettingsState.adminLoading[kind] = loader().finally(() => {
          adminSettingsState.adminLoading[kind] = null;
        });

        return adminSettingsState.adminLoading[kind];
      }

    async function loadProfile(userData = null) {
      const data = userData || API.getUser();
      if (!data || data.error) return;
      renderAdminMode(data);

      document.getElementById('settingName').value = data.name;
      document.getElementById('settingClass').value = data.is_admin ? (data.can_complete_assignments ? `${data.grade}학년 ${data.class_number}반 · 학생 관리자` : '관리자 · 전체 학년/반 조회 가능') : `${data.grade}학년 ${data.class_number}반`;

      const avatar = document.getElementById('profileAvatar');
      avatar.textContent = '';
      if (API.isSafeImageUrl(data.profile_image_url)) {
        const image = document.createElement('img');
        API.setImageSource(image, data.profile_image_url);
        image.style.width = '80px';
        image.style.height = '80px';
        image.style.borderRadius = '50%';
        image.style.objectFit = 'cover';
        image.alt = `${data.name} 프로필 이미지`;
        avatar.appendChild(image);
      } else {
        avatar.textContent = String(data.name || '?').charAt(0);
      }

      const toggle = document.getElementById('alarmToggle');
      const pendingAlarm = alarmOperation && Number(alarmOperation.accountId) === Number(data.id || data.user_id);
      const alarmEnabled = pendingAlarm ? alarmOperation.newValue : API.normalizeFlag(data.is_alarm_enabled);
      toggle.classList.toggle('on', alarmEnabled);
      toggle.setAttribute('aria-checked', String(alarmEnabled));

      const themeModeSelect = document.getElementById('themeModeSelect');
      themeModeSelect.value = API.getTheme();
      updateThemeHelpText(themeModeSelect.value, API.getResolvedTheme(themeModeSelect.value));

      const user = API.getUser();
      if (user) {
        user.name = data.name;
        user.grade = data.grade;
        user.class_number = data.class_number;
        user.is_admin = API.normalizeFlag(data.is_admin);
        user.can_switch_admin_mode = API.normalizeFlag(data.can_switch_admin_mode);
        user.admin_mode_enabled = API.normalizeFlag(data.admin_mode_enabled);
        if (pendingAlarm) user.is_alarm_enabled = alarmOperation.newValue;
        API.setUser(user);
      }
    }

    function renderAdminMode(user = API.getUser()) {
      const eligible = API.normalizeFlag(user?.can_switch_admin_mode);
      document.getElementById('adminModeSetting').hidden = !eligible;
      const toggle = document.getElementById('adminModeToggle');
      const enabled = API.normalizeFlag(user?.is_admin);
      toggle.classList.toggle('on', enabled);
      toggle.setAttribute('aria-checked', String(enabled));
      toggle.disabled = Boolean(adminModeOperation) || !eligible;
      toggle.setAttribute('aria-busy', String(Boolean(adminModeOperation)));
      document.getElementById('adminModeHelp').textContent = adminModeOperation
        ? '모드를 변경하고 있어요…'
        : enabled ? '끄면 일반 학생 권한으로 이용하며, 여기서 다시 켤 수 있어요.' : '일반 학생 모드로 이용 중이에요. 관리자 모드를 다시 켤 수 있어요.';
    }

    document.getElementById('adminModeToggle').addEventListener('click', async () => {
      const user = API.getUser();
      if (adminModeOperation || !API.normalizeFlag(user?.can_switch_admin_mode)) return;
      const operation = { scope: settingsScope(), id: user.id };
      adminModeOperation = operation;
      renderAdminMode(user);
      try {
        const result = await API.setAdminMode(!API.normalizeFlag(user.is_admin));
        if (!result?.success) throw new Error(result?.error || '모드를 변경하지 못했습니다.');
        // API installs the confirmed identity; never grant privileges locally.
        if (Number(API.getUser()?.id) !== Number(operation.id)) return;
        syncSettingsScope();
        await loadProfile(API.getUser());
        API.loadUserInfo();
        const admin = API.normalizeFlag(API.getUser()?.is_admin);
        for (const id of ['adminAssignmentSection', 'adminMessageSection', 'adminUserSection']) document.getElementById(id).style.display = admin ? 'block' : 'none';
        if (admin) {
          initAdminSelectors();
          ensureAdminSectionLoaded('assignment', { force: true }).catch(() => {});
        }
        AppUI.toast(admin ? '관리자 모드로 변경했습니다.' : '일반 학생 모드로 변경했습니다.');
      } catch (error) {
        if (operation.scope === settingsScope()) AppUI.toast(error?.message || '모드를 변경하지 못했습니다.', true);
      } finally {
        if (adminModeOperation === operation) adminModeOperation = null;
        renderAdminMode();
      }
    });

    function adminUserOptions(max, suffix, value) {
      return Array.from({ length: max }, (_, i) => {
        const optionValue = i + 1;
        return `<option value="${optionValue}"${Number(value) === optionValue ? ' selected' : ''}>${optionValue}${suffix}</option>`;
      }).join('');
    }

    function buildFilterOptions(max, suffix, selectedValue, allLabel) {
      return [`<option value="all"${selectedValue === 'all' ? ' selected' : ''}>${allLabel}</option>`]
        .concat(Array.from({ length: max }, (_, i) => {
          const optionValue = String(i + 1);
          return `<option value="${optionValue}"${selectedValue === optionValue ? ' selected' : ''}>${optionValue}${suffix}</option>`;
        }))
        .join('');
    }

    function initAdminSelectors() {
      document.getElementById('adminSettingsAssignmentGrade').innerHTML = buildFilterOptions(3, '학년', adminSettingsState.assignmentGrade, '전체 학년');
      document.getElementById('adminSettingsAssignmentClass').innerHTML = buildFilterOptions(4, '반', adminSettingsState.assignmentClass, '전체 반');
      document.getElementById('adminSettingsMessageGrade').innerHTML = buildFilterOptions(3, '학년', adminSettingsState.messageGrade, '전체 학년');
      document.getElementById('adminSettingsMessageClass').innerHTML = buildFilterOptions(4, '반', adminSettingsState.messageClass, '전체 반');
      document.getElementById('adminSettingsMessageType').value = adminSettingsState.messageType;
      syncAdminMessageSelectors();
    }

    function syncAdminMessageSelectors() {
      const classSelect = document.getElementById('adminSettingsMessageClass');
      classSelect.style.display = adminSettingsState.messageType === 'class' ? 'block' : 'none';
    }

    function getVisibleAdminAssignments() {
      return adminSettingsState.assignments;
    }

    function getVisibleAdminMessages() {
      return adminSettingsState.messages;
    }

    function renderPagination(containerId, kind, page, total, pageSize) {
      const container = document.getElementById(containerId);
      if (!container) return;

      const totalPages = Math.max(1, Math.ceil((total || 0) / pageSize));
      container.innerHTML = `
        <button type="button" class="btn btn-secondary btn-sm admin-page-btn" data-kind="${kind}" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>이전</button>
        <span class="admin-page-meta">${page} / ${totalPages} 페이지 · 총 ${total}개</span>
        <button type="button" class="btn btn-secondary btn-sm admin-page-btn" data-kind="${kind}" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>다음</button>
      `;
    }

    function pruneAssignmentStatusCache() {
      const validIds = new Set(adminSettingsState.assignments.map(assignment => String(assignment.assignment_id)));
      ['assignmentStatusById', 'assignmentStatusLoading', 'assignmentStatusOpen', 'assignmentStatusFilterById'].forEach(key => {
        Object.keys(adminSettingsState[key]).forEach(id => {
          if (!validIds.has(id)) delete adminSettingsState[key][id];
        });
      });
    }

    function renderAssignmentStatusPanel(assignmentId) {
      if (!adminSettingsState.assignmentStatusOpen[assignmentId]) return '';

      if (adminSettingsState.assignmentStatusLoading[assignmentId]) {
        return '<div class="assignment-status-panel"><div class="assignment-status-empty">불러오는 중...</div></div>';
      }

      const statusData = adminSettingsState.assignmentStatusById[assignmentId];
      if (!statusData) return '';

      if (statusData.error) {
        return `<div class="assignment-status-panel"><div class="assignment-status-empty">${API.escapeHTML(statusData.error)}</div></div>`;
      }

      if (!Array.isArray(statusData.students) || statusData.students.length === 0) {
        return '<div class="assignment-status-panel"><div class="assignment-status-empty">대상 학생이 없습니다.</div></div>';
      }

      const filter = adminSettingsState.assignmentStatusFilterById[assignmentId] || 'all';
      const filteredStudents = statusData.students.filter(student => {
        if (filter === 'completed') return Number(student.is_completed) === 1;
        if (filter === 'pending') return Number(student.is_completed) !== 1;
        return true;
      });

      return `
        <div class="assignment-status-panel">
          <div class="assignment-status-filter">
            <button type="button" class="status-filter-btn ${filter === 'all' ? 'active' : ''}" data-id="${assignmentId}" data-filter="all">전체</button>
            <button type="button" class="status-filter-btn ${filter === 'completed' ? 'active' : ''}" data-id="${assignmentId}" data-filter="completed">제출함만</button>
            <button type="button" class="status-filter-btn ${filter === 'pending' ? 'active' : ''}" data-id="${assignmentId}" data-filter="pending">미제출만</button>
          </div>
          <div class="assignment-status-list">
            ${filteredStudents.length === 0 ? '<div class="assignment-status-empty">조건에 맞는 학생이 없습니다.</div>' : filteredStudents.map(student => `
              <div class="assignment-status-item">
                <div>
                  <div class="assignment-status-name">${API.escapeHTML(student.name)}</div>
                  <div class="assignment-status-meta">${API.escapeHTML(student.grade)}학년 ${API.escapeHTML(student.class_number)}반</div>
                </div>
                <span class="assignment-status-badge ${Number(student.is_completed) === 1 ? 'done' : 'pending'}">
                  ${Number(student.is_completed) === 1 ? '제출함' : '미제출'}
                </span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    function renderAdminAssignments() {
      const container = document.getElementById('adminAssignmentList');
      const assignments = getVisibleAdminAssignments();
      if (assignments.length === 0) {
        container.innerHTML = '<div class="empty-state">선택한 범위의 과제가 없습니다.</div>';
        return;
      }

      container.innerHTML = assignments.map(assignment => {
        const statusData = adminSettingsState.assignmentStatusById[assignment.assignment_id];
        const isOpen = Boolean(adminSettingsState.assignmentStatusOpen[assignment.assignment_id]);
        const completedCount = Array.isArray(statusData?.students)
          ? statusData.students.filter(student => Number(student.is_completed) === 1).length
          : null;
        const pendingCount = Array.isArray(statusData?.students)
          ? statusData.students.length - completedCount
          : null;

        return `
          <div class="assignment-item assignment-admin-item">
            <div class="info">
              <div class="title">${API.escapeHTML(assignment.title)}</div>
              ${assignment.content ? `<div class="detail">${API.renderTextWithLinks(assignment.content)}</div>` : ''}
              <div class="meta">${API.escapeHTML(assignment.due_date)} · ${API.escapeHTML(assignment.target_class ? assignment.target_grade + '학년 ' + assignment.target_class + '반' : assignment.target_grade + '학년 전체')} · ${API.escapeHTML(assignment.creator_name || '')}</div>
              ${completedCount === null ? '' : `<div class="admin-user-meta">제출함 ${completedCount}명 · 미제출 ${pendingCount}명</div>`}
              ${renderAssignmentStatusPanel(assignment.assignment_id)}
            </div>
            <div class="actions">
              <button class="btn btn-secondary btn-sm toggle-assignment-status" data-id="${assignment.assignment_id}">${isOpen ? '제출 현황 숨기기' : '제출 현황 보기'}</button>
              <button class="btn btn-danger btn-sm delete-admin-assignment" data-id="${assignment.assignment_id}">삭제</button>
            </div>
          </div>
        `;
      }).join('');
    }

    function renderAdminMessages() {
      const container = document.getElementById('adminMessageList');
      const messages = getVisibleAdminMessages();
      if (messages.length === 0) {
        container.innerHTML = '<div class="empty-state">선택한 범위의 메세지가 없습니다.</div>';
        return;
      }

      container.innerHTML = messages.map(message => {
        const badge = message.type === 'grade' ? '<span class="msg-badge grade">학년</span>' : '<span class="msg-badge class">반</span>';
        return `
          <div class="message-item">
            <div class="msg-header">
              <span class="msg-sender">${API.escapeHTML(message.sender_name)} ${badge}</span>
              <span class="msg-time">${API.formatDateTime(message.created_at)}</span>
            </div>
            <div class="msg-content">${API.escapeHTML(message.content)}</div>
            <div class="msg-time" style="margin-top:6px">${message.type === 'grade' ? `${message.target_grade}학년` : `${message.target_grade}학년 ${message.target_class}반`}</div>
            <div class="actions" style="margin-top:10px">
              <button class="btn btn-danger btn-sm delete-admin-message" data-id="${message.message_id}">삭제</button>
            </div>
          </div>
        `;
      }).join('');
    }

      async function loadAdminAssignments({ keepVisible = false } = {}) {
        const requestScope = syncSettingsScope();
        const version = ++adminLoadVersions.assignment;
        const accountId = API.getUser()?.id;
        const params = {
          page: adminSettingsState.assignmentPage,
        pageSize: adminSettingsState.pageSize,
        grade: adminSettingsState.assignmentGrade,
        class_number: adminSettingsState.assignmentClass
      };
      keepVisible = showCachedAdminList('assignment', params) || keepVisible;
      const res = await API.getAdminAssignments(params);
      syncSettingsScope();
      if (requestScope !== settingsScope() || version !== adminLoadVersions.assignment || !sameAccount(accountId) || !API.normalizeFlag(API.getUser()?.is_admin)) return;
      if (!Array.isArray(res?.items)) {
        if (keepVisible) { AppUI.toast('최신 과제 목록을 불러오지 못해 표시된 내용을 유지합니다.', true); return; }
        document.getElementById('adminAssignmentList').innerHTML = `<div class="empty-state">${API.escapeHTML(res?.error || '과제 목록을 불러오지 못했습니다.')}<br><button class="btn btn-secondary btn-sm" type="button" data-retry-admin="assignment">다시 시도</button></div>`;
        document.getElementById('adminAssignmentPager').innerHTML = '';
        return;
      }
      const visible = overlayAdminResponse('assignment', res);
      adminSettingsState.assignments = visible.items;
      adminSettingsState.assignmentTotal = visible.total;
      adminSettingsState.assignmentPage = Number(res?.page) || 1;
        if (adminSettingsState.assignments.length === 0 && adminSettingsState.assignmentTotal > 0 && adminSettingsState.assignmentPage > 1) {
          adminSettingsState.assignmentPage -= 1;
          return loadAdminAssignments();
        }
        pruneAssignmentStatusCache();
        adminSettingsState.adminLoaded.assignment = true;
        renderAdminAssignments();
        renderPagination('adminAssignmentPager', 'assignment', adminSettingsState.assignmentPage, adminSettingsState.assignmentTotal, adminSettingsState.pageSize);
      }

    async function toggleAssignmentStatusView(assignmentId) {
      if (!assignmentId) return;
      const requestScope = syncSettingsScope();

      if (adminSettingsState.assignmentStatusOpen[assignmentId]) {
        adminSettingsState.assignmentStatusOpen[assignmentId] = false;
        renderAdminAssignments();
        return;
      }

      adminSettingsState.assignmentStatusOpen[assignmentId] = true;

      if (!adminSettingsState.assignmentStatusById[assignmentId] || adminSettingsState.assignmentStatusById[assignmentId].error) {
        adminSettingsState.assignmentStatusLoading[assignmentId] = true;
        renderAdminAssignments();

        const res = await API.getAssignmentStatus(assignmentId);
        syncSettingsScope();
        if (requestScope !== settingsScope()) return;
        if (!res || res.error) {
          adminSettingsState.assignmentStatusById[assignmentId] = {
            error: res?.error || '제출 현황을 불러오지 못했습니다.',
            students: []
          };
        } else {
          adminSettingsState.assignmentStatusById[assignmentId] = res;
        }
        adminSettingsState.assignmentStatusLoading[assignmentId] = false;
      }

      renderAdminAssignments();
    }

      async function loadAdminMessages({ keepVisible = false } = {}) {
        const requestScope = syncSettingsScope();
        const version = ++adminLoadVersions.message;
        const accountId = API.getUser()?.id;
        const params = {
        page: adminSettingsState.messagePage,
        pageSize: adminSettingsState.pageSize,
        type: adminSettingsState.messageType,
        grade: adminSettingsState.messageGrade,
        class_number: adminSettingsState.messageType === 'class' ? adminSettingsState.messageClass : null
      };
      keepVisible = showCachedAdminList('message', params) || keepVisible;
      const res = await API.getAdminMessages(params);
      syncSettingsScope();
      if (requestScope !== settingsScope() || version !== adminLoadVersions.message || !sameAccount(accountId) || !API.normalizeFlag(API.getUser()?.is_admin)) return;
      if (!Array.isArray(res?.items)) {
        if (keepVisible) { AppUI.toast('최신 공지 목록을 불러오지 못해 표시된 내용을 유지합니다.', true); return; }
        document.getElementById('adminMessageList').innerHTML = `<div class="empty-state">${API.escapeHTML(res?.error || '메세지 목록을 불러오지 못했습니다.')}<br><button class="btn btn-secondary btn-sm" type="button" data-retry-admin="message">다시 시도</button></div>`;
        document.getElementById('adminMessagePager').innerHTML = '';
        return;
      }
      const visible = overlayAdminResponse('message', res);
      adminSettingsState.messages = visible.items;
      adminSettingsState.messageTotal = visible.total;
      adminSettingsState.messagePage = Number(res?.page) || 1;
        if (adminSettingsState.messages.length === 0 && adminSettingsState.messageTotal > 0 && adminSettingsState.messagePage > 1) {
          adminSettingsState.messagePage -= 1;
          return loadAdminMessages();
        }
        adminSettingsState.adminLoaded.message = true;
        renderAdminMessages();
        renderPagination('adminMessagePager', 'message', adminSettingsState.messagePage, adminSettingsState.messageTotal, adminSettingsState.pageSize);
      }

    function renderAdminUsers() {
      const container = document.getElementById('adminUserList');
      const users = adminSettingsState.users;
      if (!Array.isArray(users) || users.length === 0) {
        container.innerHTML = '<div class="empty-state">표시할 유저가 없습니다.</div>';
        return;
      }

      container.innerHTML = users.map(user => {
        const admin = API.normalizeFlag(user.is_admin);
        const saving = adminUserUpdates.has(Number(user.user_id));
        const draft = saving ? adminUserUpdates.get(Number(user.user_id)).payload : adminUserDrafts.get(Number(user.user_id));
        return `
        <div class="admin-user-item" data-id="${Number(user.user_id)}" aria-busy="${saving}">
          <div class="admin-user-top">
            <strong>${API.escapeHTML(user.name)}</strong>
            <span class="admin-role-badge ${admin ? 'admin' : 'student'}">${admin ? (API.normalizeFlag(user.can_complete_assignments) ? '학생 관리자' : '관리자') : '학생'}</span>
          </div>
          <div class="admin-user-meta">학교 계정 · ${API.escapeHTML(user.google_email || '미등록')}</div>
          <div class="admin-user-grid">
              <div class="form-group">
                <label>이름</label>
                <input aria-label="사용자 이름" type="text" class="admin-name-input" value="${API.escapeHTML(user.name)}" disabled>
              </div>
            <div class="form-group">
              <label>학년</label>
              <select aria-label="사용자 학년" class="admin-grade-select" ${saving ? 'disabled' : ''}>${adminUserOptions(3, '학년', draft?.grade ?? user.grade)}</select>
            </div>
            <div class="form-group">
              <label>반</label>
              <select aria-label="사용자 반" class="admin-class-select" ${saving ? 'disabled' : ''}>${adminUserOptions(4, '반', draft?.class_number ?? user.class_number)}</select>
            </div>
          </div>
          <div class="admin-user-meta">생성일 ${API.formatDateTime(user.created_at)}</div>
          <div class="admin-user-actions">
            <button class="btn btn-primary btn-sm save-admin-user" ${saving ? 'disabled' : ''}>${saving ? '저장 중…' : '저장'}</button>
            ${admin ? '' : `<button class="btn btn-danger btn-sm delete-admin-user" ${saving ? 'disabled' : ''}>삭제</button>`}
          </div>
        </div>
      `;
      }).join('');
    }

      async function loadAdminUsers({ keepVisible = false } = {}) {
        const requestScope = syncSettingsScope();
        const version = ++adminLoadVersions.user;
        const accountId = API.getUser()?.id;
        const params = {
        page: adminSettingsState.userPage,
        pageSize: adminSettingsState.pageSize
      };
      keepVisible = showCachedAdminList('user', params) || keepVisible;
      const res = await API.getAdminUsers(params);
      syncSettingsScope();
      if (requestScope !== settingsScope() || version !== adminLoadVersions.user || !sameAccount(accountId) || !API.normalizeFlag(API.getUser()?.is_admin)) return;
      if (!Array.isArray(res?.items)) {
        if (keepVisible) { AppUI.toast('최신 사용자 목록을 불러오지 못해 표시된 내용을 유지합니다.', true); return; }
        document.getElementById('adminUserList').innerHTML = `<div class="empty-state">${API.escapeHTML(res?.error || '유저 목록을 불러오지 못했습니다.')}<br><button class="btn btn-secondary btn-sm" type="button" data-retry-admin="user">다시 시도</button></div>`;
        document.getElementById('adminUserPager').innerHTML = '';
        return;
      }

      const visible = overlayAdminResponse('user', res);
      adminSettingsState.users = visible.items;
      adminSettingsState.userTotal = visible.total;
      adminSettingsState.userPage = Number(res?.page) || 1;
        if (adminSettingsState.users.length === 0 && adminSettingsState.userTotal > 0 && adminSettingsState.userPage > 1) {
          adminSettingsState.userPage -= 1;
          return loadAdminUsers();
        }
        adminSettingsState.adminLoaded.user = true;
        renderAdminUsers();
        renderPagination('adminUserPager', 'user', adminSettingsState.userPage, adminSettingsState.userTotal, adminSettingsState.pageSize);
      }

    document.getElementById('alarmToggle').addEventListener('click', async function() {
      if (this.disabled || alarmOperation) return;
      const user = API.getUser();
      if (!user) return;
      const before = this.classList.contains('on');
      const newValue = !before;
      const operation = { accountId: user.id, before, newValue };
      alarmOperation = operation;
      this.disabled = true;
      this.classList.toggle('on', newValue);
      this.setAttribute('aria-checked', String(newValue));
      this.setAttribute('aria-busy', 'true');
      API.setUser({ ...API.getUser(), is_alarm_enabled: newValue });
      try {
        const result = await API.updateUser(user.id, { is_alarm_enabled: newValue ? 1 : 0 });
        if (!result?.success) throw new Error(result?.error || '알림 설정을 저장하지 못했습니다.');
        if (alarmOperation === operation && sameAccount(operation.accountId)) {
          AppUI.toast(newValue ? '과제 알림을 켰습니다.' : '과제 알림을 껐습니다.');
        }
      } catch (error) {
        if (alarmOperation === operation && sameAccount(operation.accountId)) {
          const current = API.getUser();
          if (API.normalizeFlag(current?.is_alarm_enabled) === newValue) {
            API.setUser({ ...current, is_alarm_enabled: before });
            this.classList.toggle('on', before);
            this.setAttribute('aria-checked', String(before));
          }
          AppUI.toast((error?.message || '설정 저장에 실패했습니다.') + ' 알림 설정을 되돌렸습니다.', true);
        }
      } finally {
        if (alarmOperation === operation) {
          alarmOperation = null;
          this.disabled = false;
          this.setAttribute('aria-busy', 'false');
        }
      }
    });

    function updateThemeHelpText(theme, resolvedTheme) {
      const helpText = document.getElementById('themeModeHelp');
      if (!helpText) return;
      if (theme === 'system') {
        helpText.textContent = `시스템 설정을 따라갑니다. 현재 ${resolvedTheme === 'dark' ? '다크모드' : '라이트모드'}가 적용 중입니다.`;
        return;
      }
      helpText.textContent = `앱 전체에 ${theme === 'dark' ? '다크모드' : '라이트모드'}를 고정해서 적용합니다.`;
    }

    document.getElementById('themeModeSelect').addEventListener('change', function() {
      const nextTheme = API.setTheme(this.value);
      updateThemeHelpText(nextTheme, API.getResolvedTheme(nextTheme));
    });

    window.addEventListener('themechange', (event) => {
      const themeModeSelect = document.getElementById('themeModeSelect');
      if (!themeModeSelect) return;
      const currentTheme = event.detail?.theme || API.getTheme();
      const resolvedTheme = event.detail?.resolvedTheme || API.getResolvedTheme(currentTheme);
      themeModeSelect.value = currentTheme;
      updateThemeHelpText(currentTheme, resolvedTheme);
    });

    document.getElementById('adminUserList').addEventListener('change', (event) => {
      if (!event.target.classList.contains('admin-grade-select') && !event.target.classList.contains('admin-class-select')) return;
      const item = event.target.closest('.admin-user-item');
      const id = Number(item?.dataset.id);
      if (!id || adminUserUpdates.has(id)) return;
      adminUserDrafts.set(id, {
        grade: Number(item.querySelector('.admin-grade-select').value),
        class_number: Number(item.querySelector('.admin-class-select').value)
      });
    });
    document.getElementById('adminUserList').addEventListener('click', async (event) => {
      if (!API.normalizeFlag(API.getUser()?.is_admin)) return;
      const item = event.target.closest('.admin-user-item');
      const userId = Number(item?.dataset.id);
      if (!userId) return;
      const save = event.target.closest('.save-admin-user');
      if (save) {
        if (save.disabled) return;
        return saveAdminUser(userId, {
          grade: Number(item.querySelector('.admin-grade-select').value),
          class_number: Number(item.querySelector('.admin-class-select').value)
        });
      }
      const remove = event.target.closest('.delete-admin-user');
      if (!remove || remove.disabled || adminDeletes.user.has(userId) || adminUserUpdates.has(userId)) return;
      if (!confirm('이 계정과 이 사용자가 등록한 과제·공지, 관련 제출 기록을 모두 삭제하시겠습니까? 삭제하면 되돌릴 수 없습니다.')) return;
      return deleteAdminRecord('user', userId, id => API.deleteAdminUser(id));
    });

    document.getElementById('adminAssignmentList').addEventListener('click', async (e) => {
      const toggleButton = e.target.closest('.toggle-assignment-status');
      if (toggleButton) {
        await toggleAssignmentStatusView(parseInt(toggleButton.dataset.id, 10));
        return;
      }

      const filterButton = e.target.closest('.status-filter-btn');
      if (filterButton) {
        adminSettingsState.assignmentStatusFilterById[filterButton.dataset.id] = filterButton.dataset.filter;
        renderAdminAssignments();
        return;
      }

      const deleteButton = e.target.closest('.delete-admin-assignment');
      const id = Number(deleteButton?.dataset.id);
      if (!deleteButton || deleteButton.disabled || adminDeletes.assignment.has(id)) return;
      if (!API.normalizeFlag(API.getUser()?.is_admin) || !confirm('정말 이 과제를 삭제하시겠습니까?')) return;
      return deleteAdminRecord('assignment', id, assignmentId => API.deleteAssignment(assignmentId));
    });

    document.getElementById('adminMessageList').addEventListener('click', async (event) => {
      const button = event.target.closest('.delete-admin-message');
      const id = Number(button?.dataset.id);
      if (!button || button.disabled || adminDeletes.message.has(id)) return;
      if (!API.normalizeFlag(API.getUser()?.is_admin) || !confirm('정말 이 메세지를 삭제하시겠습니까?')) return;
      return deleteAdminRecord('message', id, messageId => API.deleteMessage(messageId));
    });

      document.querySelectorAll('.admin-accordion-toggle').forEach(button => {
        button.addEventListener('click', async () => {
          const panel = document.getElementById(button.dataset.target);
          const isOpen = button.classList.toggle('open');
          panel.classList.toggle('show', isOpen);
          button.setAttribute('aria-expanded', String(isOpen));
          if (!isOpen) return;

          if (button.dataset.target === 'adminAssignmentPanel') {
            await ensureAdminSectionLoaded('assignment');
            return;
          }
          if (button.dataset.target === 'adminMessagePanel') {
            await ensureAdminSectionLoaded('message');
            return;
          }
          if (button.dataset.target === 'adminUserPanel') {
            await ensureAdminSectionLoaded('user');
          }
        });
      });

    document.getElementById('adminSettingsAssignmentGrade').addEventListener('change', async (e) => {
      adminSettingsState.assignmentGrade = e.target.value;
      adminSettingsState.assignmentPage = 1;
      if (adminSettingsState.assignmentGrade === 'all') {
        adminSettingsState.assignmentClass = 'all';
        document.getElementById('adminSettingsAssignmentClass').value = 'all';
      }
      await loadAdminAssignments();
    });

    document.getElementById('adminSettingsAssignmentClass').addEventListener('change', async (e) => {
      adminSettingsState.assignmentClass = e.target.value;
      adminSettingsState.assignmentPage = 1;
      await loadAdminAssignments();
    });

    document.getElementById('adminSettingsMessageType').addEventListener('change', async (e) => {
      adminSettingsState.messageType = e.target.value;
      adminSettingsState.messagePage = 1;
      if (adminSettingsState.messageType !== 'class') {
        adminSettingsState.messageClass = 'all';
        document.getElementById('adminSettingsMessageClass').value = 'all';
      }
      syncAdminMessageSelectors();
      await loadAdminMessages();
    });

    document.getElementById('adminSettingsMessageGrade').addEventListener('change', async (e) => {
      adminSettingsState.messageGrade = e.target.value;
      adminSettingsState.messagePage = 1;
      await loadAdminMessages();
    });

    document.getElementById('adminSettingsMessageClass').addEventListener('change', async (e) => {
      adminSettingsState.messageClass = e.target.value;
      adminSettingsState.messagePage = 1;
      await loadAdminMessages();
    });

    document.addEventListener('click', async (e) => {
      const retry = e.target.closest('[data-retry-admin]');
      if (retry) { await ensureAdminSectionLoaded(retry.dataset.retryAdmin, { force: true }); return; }
      const pageButton = e.target.closest('.admin-page-btn');
      if (!pageButton || pageButton.disabled) return;

      const nextPage = parseInt(pageButton.dataset.page, 10);
      if (!nextPage || nextPage < 1) return;

      if (pageButton.dataset.kind === 'assignment') {
        adminSettingsState.assignmentPage = nextPage;
        await loadAdminAssignments();
        return;
      }
      if (pageButton.dataset.kind === 'message') {
        adminSettingsState.messagePage = nextPage;
        await loadAdminMessages();
        return;
      }
      if (pageButton.dataset.kind === 'user') {
        adminSettingsState.userPage = nextPage;
        await loadAdminUsers();
      }
    });

    init().catch(() => AppUI.toast('설정을 불러오지 못했습니다. 새로고침해주세요.', true));
