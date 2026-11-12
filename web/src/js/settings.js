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

    async function init() {
      const user = await API.ensureUser();
      if (!user) return;
      API.loadUserInfo();
      API.initNotifications().catch(() => {});
      await loadProfile(user);
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
      const alarmEnabled = API.normalizeFlag(data.is_alarm_enabled);
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
        API.setUser(user);
      }
    }

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
              <span class="msg-time">${new Date(message.created_at).toLocaleString('ko-KR')}</span>
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

      async function loadAdminAssignments() {
        const version = ++adminLoadVersions.assignment;
        const res = await API.getAdminAssignments({
          page: adminSettingsState.assignmentPage,
        pageSize: adminSettingsState.pageSize,
        grade: adminSettingsState.assignmentGrade,
        class_number: adminSettingsState.assignmentClass
      });
      if (version !== adminLoadVersions.assignment) return;
      if (!Array.isArray(res?.items)) {
        document.getElementById('adminAssignmentList').innerHTML = `<div class="empty-state">${API.escapeHTML(res?.error || '과제 목록을 불러오지 못했습니다.')}<br><button class="btn btn-secondary btn-sm" type="button" data-retry-admin="assignment">다시 시도</button></div>`;
        document.getElementById('adminAssignmentPager').innerHTML = '';
        return;
      }
      adminSettingsState.assignments = Array.isArray(res?.items) ? res.items : [];
      adminSettingsState.assignmentTotal = Number(res?.total) || 0;
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

      async function loadAdminMessages() {
        const version = ++adminLoadVersions.message;
        const res = await API.getAdminMessages({
        page: adminSettingsState.messagePage,
        pageSize: adminSettingsState.pageSize,
        type: adminSettingsState.messageType,
        grade: adminSettingsState.messageGrade,
        class_number: adminSettingsState.messageType === 'class' ? adminSettingsState.messageClass : null
      });
      if (version !== adminLoadVersions.message) return;
      if (!Array.isArray(res?.items)) {
        document.getElementById('adminMessageList').innerHTML = `<div class="empty-state">${API.escapeHTML(res?.error || '메세지 목록을 불러오지 못했습니다.')}<br><button class="btn btn-secondary btn-sm" type="button" data-retry-admin="message">다시 시도</button></div>`;
        document.getElementById('adminMessagePager').innerHTML = '';
        return;
      }
      adminSettingsState.messages = Array.isArray(res?.items) ? res.items : [];
      adminSettingsState.messageTotal = Number(res?.total) || 0;
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
        return `
        <div class="admin-user-item" data-id="${Number(user.user_id)}">
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
              <select aria-label="사용자 학년" class="admin-grade-select">${adminUserOptions(3, '학년', user.grade)}</select>
            </div>
            <div class="form-group">
              <label>반</label>
              <select aria-label="사용자 반" class="admin-class-select">${adminUserOptions(4, '반', user.class_number)}</select>
            </div>
          </div>
          <div class="admin-user-meta">생성일 ${new Date(user.created_at).toLocaleString('ko-KR')}</div>
          <div class="admin-user-actions">
            <button class="btn btn-primary btn-sm save-admin-user">저장</button>
            ${admin ? '' : '<button class="btn btn-danger btn-sm delete-admin-user">삭제</button>'}
          </div>
        </div>
      `;
      }).join('');
    }

      async function loadAdminUsers() {
        const version = ++adminLoadVersions.user;
        const res = await API.getAdminUsers({
        page: adminSettingsState.userPage,
        pageSize: adminSettingsState.pageSize
      });
      if (version !== adminLoadVersions.user) return;
      if (!Array.isArray(res?.items)) {
        document.getElementById('adminUserList').innerHTML = `<div class="empty-state">${API.escapeHTML(res?.error || '유저 목록을 불러오지 못했습니다.')}<br><button class="btn btn-secondary btn-sm" type="button" data-retry-admin="user">다시 시도</button></div>`;
        document.getElementById('adminUserPager').innerHTML = '';
        return;
      }

      adminSettingsState.users = res.items;
      adminSettingsState.userTotal = Number(res?.total) || 0;
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
      if (this.disabled) return;
      const user = API.getUser();
      if (!user) return;
      const newValue = !this.classList.contains('on');
      this.disabled = true;
      try {
        const result = await API.updateUser(user.id, { is_alarm_enabled: newValue ? 1 : 0 });
        if (!result?.success) throw new Error(result?.error || '알림 설정을 저장하지 못했습니다.');
        this.classList.toggle('on', newValue);
        this.setAttribute('aria-checked', String(newValue));
        API.setUser({ ...user, is_alarm_enabled: newValue });
        AppUI.toast(newValue ? '과제 알림을 켰습니다.' : '과제 알림을 껐습니다.');
      } catch (error) { AppUI.toast(error.message || '설정 저장에 실패했습니다.', true); }
      finally { this.disabled = false; }
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

    document.getElementById('adminUserList').addEventListener('click', async (e) => {
      if (!API.normalizeFlag(API.getUser()?.is_admin)) return;
      const item = e.target.closest('.admin-user-item');
      if (!item) return;
      const userId = parseInt(item.dataset.id, 10);
      if (!userId) return;

        if (e.target.classList.contains('save-admin-user')) {
          const button = e.target;
          if (button.disabled) return;
          const current = adminSettingsState.users.find(user => Number(user.user_id) === userId);
          if (!current) { alert('사용자 목록을 새로고침한 뒤 다시 시도해주세요.'); return; }
          const payload = {
            grade: parseInt(item.querySelector('.admin-grade-select').value, 10),
            class_number: parseInt(item.querySelector('.admin-class-select').value, 10)
          };
          button.disabled = true;
          try {
            const res = await API.updateAdminUser(userId, payload);
            if (!res || res.error) { alert(res?.error || '저장에 실패했습니다.'); return; }
            alert('사용자 정보가 저장되었습니다.');
            await loadAdminUsers();
          } catch { alert('사용자 정보를 저장하지 못했습니다. 다시 시도해주세요.'); }
          finally { button.disabled = false; }
          return;
        }

      if (e.target.classList.contains('delete-admin-user')) {
        if (!confirm('정말 이 계정을 삭제하시겠습니까?')) return;
        const res = await API.deleteAdminUser(userId);
        if (!res || res.error) {
          alert(res?.error || '삭제에 실패했습니다.');
          return;
        }
        await loadAdminUsers();
      }
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
      if (!deleteButton) return;
      if (!confirm('정말 이 과제를 삭제하시겠습니까?')) return;
      const res = await API.deleteAssignment(parseInt(deleteButton.dataset.id, 10));
      if (!res || res.error) {
        alert(res?.error || '과제 삭제에 실패했습니다.');
        return;
      }
      await loadAdminAssignments();
      await API.refreshNotifications();
    });

    document.getElementById('adminMessageList').addEventListener('click', async (e) => {
      if (!e.target.classList.contains('delete-admin-message')) return;
      if (!confirm('정말 이 메세지를 삭제하시겠습니까?')) return;
      const res = await API.deleteMessage(parseInt(e.target.dataset.id, 10));
      if (!res || res.error) {
        alert(res?.error || '메세지 삭제에 실패했습니다.');
        return;
      }
      await loadAdminMessages();
      await API.refreshNotifications();
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
