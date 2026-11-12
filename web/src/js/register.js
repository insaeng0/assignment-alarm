API.requireAuth();
    let adminGradeFilter = 'all';
    let adminClassFilter = 'all';
    let editingAssignmentId = null;
    let isUploadingTaskImage = false;
    let uploadOperation = null;
    let imagesEnabled = false;
    let listVersion = 0;
    let mutationVersion = 0;
    let assignmentsCache = [];
    let operationSequence = 0;
    let draftRevision = 0;
    let lastResetDraft = null;
    let listError = '';
    let assignmentScope = null;
    let dashboardRedirectScope = null;
    const pendingOperations = new Map();
    const confirmedOverrides = new Map();
    const failedDrafts = new Map();

    function currentAssignmentScope() {
      const user = API.getUser();
      if (!user?.id) return null;
      return JSON.stringify([API.getAuthRealm?.() || API.getApiOrigin?.() || 'same-origin',
        String(user.id), String(user.grade), String(user.class_number), String(user.is_admin), String(user.can_complete_assignments)]);
    }

    function syncAssignmentScope() {
      const next = currentAssignmentScope();
      if (next === assignmentScope) return next;
      assignmentScope = next;
      assignmentsCache = [];
      pendingOperations.clear(); confirmedOverrides.clear(); failedDrafts.clear();
      dashboardRedirectScope = null;
      listVersion += 1; mutationVersion += 1; listError = '';
      uploadOperation = null; isUploadingTaskImage = false;
      document.getElementById('insertImageBtn').disabled = false;
      document.getElementById('saveBtn').disabled = false;
      adminGradeFilter = 'all'; adminClassFilter = 'all';
      resetAssignmentForm();
      const user = API.getUser();
      document.getElementById('adminTargetRow').style.display = user?.is_admin ? 'flex' : 'none';
      if (user?.is_admin) { initAdminFilters(user); initTargetSelectors(user); }
      else document.getElementById('adminAssignmentFilter').classList.remove('show');
      document.getElementById('targetScope').value = !user ? '' : user.is_admin
        ? '관리자는 원하는 학년/반을 선택해서 과제를 등록할 수 있습니다.' : `${user.grade}학년 ${user.class_number}반`;
      document.getElementById('assignmentListTitle').textContent = user?.is_admin ? '전체 과제 관리' : '내가 등록한 과제';
      const cached = next ? API.getCachedData?.('/api/assignments') : null;
      if (Array.isArray(cached)) assignmentsCache = cached.slice();
      document.getElementById('myAssignments').innerHTML = '';
      return next;
    }

    function ownsAssignmentScope(scope) {
      if (scope && scope === assignmentScope && scope === currentAssignmentScope()) return true;
      syncAssignmentScope();
      renderAssignments();
      return false;
    }

    function applyImageConfig(config) {
      imagesEnabled = config?.imagesEnabled === true;
      document.getElementById('insertImageBtn').hidden = !imagesEnabled;
      document.getElementById('imageUploadHint').textContent = !config ? '설명이나 참고 링크를 적어주세요.' : imagesEnabled
        ? '설명이나 참고 링크를 적어주세요. PNG, JPG, WebP, GIF 이미지(개당 4MB 이하)도 추가할 수 있어요.'
        : '설명이나 참고 링크를 적어주세요. 현재 서버에서는 이미지 업로드를 지원하지 않습니다.';
    }

    async function init() {
      if (API.getUser()) { syncAssignmentScope(); renderAssignments(); applyImageConfig(API.getCachedPublicConfig?.()); }
      const user = await API.ensureUser();
      if (!user) return;
      API.loadUserInfo();
      API.initNotifications().catch(() => {});
      document.getElementById('targetScope').value = user.is_admin ? '관리자는 원하는 학년/반을 선택해서 과제를 등록할 수 있습니다.' : `${user.grade}학년 ${user.class_number}반`;
      document.getElementById('assignmentListTitle').textContent = user.is_admin ? '전체 과제 관리' : '내가 등록한 과제';
      initAdminFilters(user);
      initTargetSelectors(user);
      resetAssignmentForm();
      applyImageConfig(API.getCachedPublicConfig?.());
      // Configuration and the first list request are independent. A slow
      // configuration response must not hold back already cached assignments.
      await Promise.allSettled([
        loadMyAssignments(user),
        API.publicConfig().then(applyImageConfig)
      ]);
    }

    function initTargetSelectors(user) {
      if (!user || !user.is_admin) return;
      const row = document.getElementById('adminTargetRow');
      const gradeSelect = document.getElementById('adminTargetGrade');
      const classSelect = document.getElementById('adminTargetClass');
      row.style.display = 'flex';
      gradeSelect.innerHTML = Array.from({ length: 3 }, (_, i) => `<option value="${i + 1}">${i + 1}학년</option>`).join('');
      classSelect.innerHTML = Array.from({ length: 4 }, (_, i) => `<option value="${i + 1}">${i + 1}반</option>`).join('');
      gradeSelect.value = String(user.grade || 1);
      classSelect.value = String(user.class_number || 1);
    }

    function initAdminFilters(user) {
      if (!user || !user.is_admin) return;

      const wrap = document.getElementById('adminAssignmentFilter');
      const gradeSelect = document.getElementById('adminAssignmentGradeFilter');
      const classSelect = document.getElementById('adminAssignmentClassFilter');

      wrap.classList.add('show');
      gradeSelect.innerHTML = ['<option value="all">전체 학년</option>']
        .concat(Array.from({ length: 3 }, (_, i) => `<option value="${i + 1}">${i + 1}학년</option>`))
        .join('');
      classSelect.innerHTML = ['<option value="all">전체 반</option>']
        .concat(Array.from({ length: 4 }, (_, i) => `<option value="${i + 1}">${i + 1}반</option>`))
        .join('');
      gradeSelect.value = adminGradeFilter;
      classSelect.value = adminClassFilter;
    }

    function getVisibleAssignments(user, data) {
      if (!user.is_admin) {
        return Array.isArray(data) ? data.filter(a => Number(a.created_by) === Number(user.id)) : [];
      }

      return (Array.isArray(data) ? data : []).filter(a => {
        const gradeMatch = adminGradeFilter === 'all' || String(a.target_grade) === adminGradeFilter;
        const classMatch = adminClassFilter === 'all' || String(a.target_class) === adminClassFilter;
        return gradeMatch && classMatch;
      });
    }

    function renderContentPreview() {
      const value = document.getElementById('taskContent').value.trim();
      const wrap = document.getElementById('taskContentPreviewWrap');
      const preview = document.getElementById('taskContentPreview');
      if (!value) {
        wrap.style.display = 'none';
        preview.innerHTML = '';
        return;
      }

      wrap.style.display = 'block';
      preview.innerHTML = API.renderTextWithLinks(value);
    }

    function insertTextAtCursor(element, text) {
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? element.value.length;
      const currentValue = element.value;
      element.value = `${currentValue.slice(0, start)}${text}${currentValue.slice(end)}`;
      const nextPosition = start + text.length;
      element.focus();
      element.setSelectionRange(nextPosition, nextPosition);
      draftRevision += 1;
      renderContentPreview();
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('file-read-failed'));
        reader.readAsDataURL(file);
      });
    }

    async function uploadImagesToContent(files) {
      const scope = syncAssignmentScope();
      if (!scope) return;
      if (isUploadingTaskImage || !imagesEnabled) return;
      const imageFiles = Array.from(files || []).filter(file => file && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type));
      if (imageFiles.some(file => file.size > 4 * 1024 * 1024)) { AppUI.toast('이미지는 개당 4MB 이하로 선택해주세요.', true); return; }
      if (imageFiles.length === 0) return;

      const contentField = document.getElementById('taskContent');
      isUploadingTaskImage = true;
      const operation = { scope };
      uploadOperation = operation;
      draftRevision += 1;
      document.getElementById('insertImageBtn').disabled = true;
      document.getElementById('saveBtn').disabled = true;

      try {
        for (const file of imageFiles) {
          const dataUrl = await readFileAsDataUrl(file);
          if (!ownsAssignmentScope(scope) || uploadOperation !== operation) return;
          const result = await API.uploadAssignmentImage(dataUrl, file.name);
          if (!ownsAssignmentScope(scope) || uploadOperation !== operation) return;
          if (!result || !result.success || !result.markdown) {
            throw new Error(result?.error || 'image-upload-failed');
          }

          const prefix = contentField.value && !contentField.value.endsWith('\n') ? '\n' : '';
          insertTextAtCursor(contentField, `${prefix}${result.markdown}\n`);
        }
      } catch (error) {
        if (ownsAssignmentScope(scope) && uploadOperation === operation) AppUI.toast(error?.message || '이미지 업로드에 실패했습니다.', true);
      } finally {
        if (uploadOperation === operation) {
          uploadOperation = null;
          isUploadingTaskImage = false;
          document.getElementById('insertImageBtn').disabled = false;
          document.getElementById('saveBtn').disabled = false;
        }
      }
    }

    function resetAssignmentForm() {
      draftRevision += 1;
      editingAssignmentId = null;
      document.getElementById('assignmentFormTitle').textContent = '새 과제 등록';
      document.getElementById('saveBtn').textContent = '등록하기';
      document.getElementById('cancelEditBtn').style.display = 'none';
      document.getElementById('taskTitle').value = '';
      document.getElementById('taskContent').value = '';
      document.getElementById('taskDate').value = AppUI.localDate();
      document.getElementById('taskImageInput').value = '';
      renderContentPreview();

      const user = API.getUser();
      if (user && user.is_admin) {
        document.getElementById('adminTargetGrade').value = String(user.grade || 1);
        document.getElementById('adminTargetClass').value = String(user.class_number || 1);
      }
      lastResetDraft = captureDraft();
    }

    function startEditAssignment(assignment) {
      if (assignment._operationId) return;
      draftRevision += 1;
      editingAssignmentId = assignment.assignment_id;
      document.getElementById('assignmentFormTitle').textContent = '과제 수정';
      document.getElementById('saveBtn').textContent = '수정하기';
      document.getElementById('cancelEditBtn').style.display = 'inline-flex';
      document.getElementById('taskTitle').value = assignment.title || '';
      document.getElementById('taskContent').value = assignment.content || '';
      document.getElementById('taskDate').value = assignment.due_date || '';

      const user = API.getUser();
      if (user && user.is_admin) {
        document.getElementById('adminTargetGrade').value = String(assignment.target_grade || user.grade || 1);
        document.getElementById('adminTargetClass').value = String(assignment.target_class || user.class_number || 1);
      }

      renderContentPreview();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function captureDraft() {
      return {
        editingId: editingAssignmentId,
        title: document.getElementById('taskTitle').value,
        content: document.getElementById('taskContent').value,
        dueDate: document.getElementById('taskDate').value,
        grade: document.getElementById('adminTargetGrade').value,
        classNumber: document.getElementById('adminTargetClass').value
      };
    }

    function sameDraft(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

    function redirectAfterConfirmedRegistration(scope) {
      if (dashboardRedirectScope !== scope || !ownsAssignmentScope(scope)) return;
      if (pendingOperations.size) return;
      // A successful earlier create must not discard a newer draft or a failed
      // queued save. Navigate only after the confirmed work leaves a clean form.
      dashboardRedirectScope = null;
      if (isUploadingTaskImage || failedDrafts.size || editingAssignmentId !== null || !sameDraft(captureDraft(), lastResetDraft)) return;
      window.location.href = 'calendar.html';
    }

    function restoreDraft(draft) {
      draftRevision += 1;
      editingAssignmentId = draft.editingId;
      document.getElementById('assignmentFormTitle').textContent = draft.editingId ? '과제 수정' : '새 과제 등록';
      document.getElementById('saveBtn').textContent = draft.editingId ? '수정하기' : '등록하기';
      document.getElementById('cancelEditBtn').style.display = draft.editingId ? 'inline-flex' : 'none';
      document.getElementById('taskTitle').value = draft.title;
      document.getElementById('taskContent').value = draft.content;
      document.getElementById('taskDate').value = draft.dueDate;
      document.getElementById('adminTargetGrade').value = draft.grade;
      document.getElementById('adminTargetClass').value = draft.classNumber;
      renderContentPreview();
    }

    function recoverFailedDraft(operation) {
      if (!operation.draft) return;
      if (!isUploadingTaskImage && draftRevision === operation.clearedRevision && sameDraft(captureDraft(), operation.clearedDraft)) {
        restoreDraft(operation.draft);
      } else {
        // Keep a recoverable copy when another draft is already being typed.
        // Restoring an older failure must never overwrite that newer input.
        failedDrafts.set(operation.key, operation.draft);
      }
    }

    function invalidateListLoads() {
      mutationVersion += 1;
      document.getElementById('myAssignments').setAttribute('aria-busy', 'false');
    }

    function overlayPending(data, readMutationVersion = -1) {
      let merged = data.slice();
      // A response may have begun before a save/delete was confirmed. Preserve
      // those newer results while still accepting all untouched server rows.
      for (const [id, change] of confirmedOverrides) {
        if (change.version <= readMutationVersion) continue;
        const index = merged.findIndex(item => String(item.assignment_id) === id);
        if (change.type === 'delete') { if (index >= 0) merged.splice(index, 1); }
        else if (index >= 0) merged[index] = change.assignment;
        else merged.unshift(change.assignment);
      }
      for (const operation of pendingOperations.values()) {
        const index = merged.findIndex(item => String(item.assignment_id) === String(operation.id));
        if (operation.type === 'delete') {
          if (index >= 0) merged.splice(index, 1);
        } else if (index >= 0) merged[index] = operation.optimistic;
        else merged.unshift(operation.optimistic);
      }
      return merged;
    }

    function cacheConfirmedAssignments(scope) {
      if (!ownsAssignmentScope(scope)) return;
      if (pendingOperations.size || typeof API.setCachedData !== 'function') return;
      try {
        API.setCachedData('/api/assignments', assignmentsCache.map(({ _saved, _operationId, ...assignment }) => assignment));
      } catch { /* A cache failure must not roll back a confirmed server write. */ }
    }

    function renderAssignments() {
      syncAssignmentScope();
      const user = API.getUser();
      if (!user) return;
      const container = document.getElementById('myAssignments');
      const visible = getVisibleAssignments(user, assignmentsCache);
      const deleting = [...pendingOperations.values()].filter(operation => operation.type === 'delete').length;
      const banners = [
        listError ? `<div class="empty-state" role="status">${API.escapeHTML(listError)} <button class="btn btn-secondary btn-sm retry-my" type="button">다시 시도</button></div>` : '',
        deleting ? `<p class="field-help" role="status">${deleting}개 과제 삭제 중…</p>` : '',
        ...[...failedDrafts].map(([key, draft]) => `<p class="field-help" role="status">저장하지 못한 과제: ${API.escapeHTML(draft.title)} <button class="btn btn-secondary btn-sm restore-draft" type="button" data-operation="${key}">입력 복원</button></p>`)
      ].join('');
      container.innerHTML = banners + (visible.length ? visible.map(assignment => {
        const pending = Boolean(assignment._operationId);
        const status = pending ? '저장 중…' : assignment._saved ? '저장됨' : '';
        const id = API.escapeHTML(String(assignment.assignment_id));
        return `<div class="assignment-item"${pending ? ' aria-busy="true"' : ''}>
          <div class="info">
            <div class="title">${API.escapeHTML(assignment.title)}</div>
            ${assignment.content ? `<div class="detail">${API.renderTextWithLinks(assignment.content)}</div>` : ''}
            <div class="meta">${API.escapeHTML(assignment.due_date)} · ${API.escapeHTML(assignment.target_class ? assignment.target_grade + '학년 ' + assignment.target_class + '반' : assignment.target_grade + '학년 전체')} · ${API.escapeHTML(assignment.creator_name || '')}${status ? ` · <span role="status">${status}</span>` : ''}</div>
          </div>
          <div class="actions">
            <button class="btn btn-secondary btn-sm edit-my" data-id="${id}"${pending ? ' disabled' : ''}>수정</button>
            <button class="btn btn-danger btn-sm delete-my" data-id="${id}"${pending ? ' disabled' : ''}>삭제</button>
          </div>
        </div>`;
      }).join('') : `<div class="empty-state">${user.is_admin ? '등록된 과제가 없습니다.' : '등록한 과제가 없습니다.'}</div>`);
    }

    async function loadMyAssignments(knownUser = API.getUser()) {
      const user = knownUser || await API.ensureUser();
      if (!user) return;
      const scope = syncAssignmentScope();
      if (!scope) return;
      const cached = API.getCachedData?.('/api/assignments');
      if (!assignmentsCache.length && Array.isArray(cached)) {
        assignmentsCache = overlayPending(cached);
      }
      renderAssignments();
      const version = ++listVersion;
      const readMutationVersion = mutationVersion;
      const container = document.getElementById('myAssignments');
      container.setAttribute('aria-busy', 'true');
      try {
        const data = await API.getAssignments();
        if (!ownsAssignmentScope(scope)) return;
        if (version !== listVersion) return;
        listError = Array.isArray(data) ? '' : data?.error || '과제를 불러오지 못했습니다.';
        if (Array.isArray(data)) {
          assignmentsCache = overlayPending(data, readMutationVersion);
          for (const [id, change] of confirmedOverrides) if (change.version <= readMutationVersion) confirmedOverrides.delete(id);
        }
        renderAssignments();
      } catch (error) {
        if (ownsAssignmentScope(scope) && version === listVersion) { listError = error?.message || '과제를 불러오지 못했습니다.'; renderAssignments(); }
      } finally {
        if (version === listVersion) container.setAttribute('aria-busy', 'false');
      }
    }

    document.getElementById('assignmentForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const scope = syncAssignmentScope();
      if (!scope) return;
      if (isUploadingTaskImage || !event.currentTarget.reportValidity()) return;
      const draft = captureDraft();
      const title = draft.title.trim();
      const content = draft.content.trim();
      const due_date = draft.dueDate;
      if (!title || !due_date) { AppUI.toast('과제명과 마감일을 입력해주세요.', true); return; }
      const user = API.getUser();
      if (!user) return;
      const payload = { title, content: content || null, due_date };
      if (user.is_admin) {
        payload.target_grade = parseInt(draft.grade, 10);
        payload.target_class = parseInt(draft.classNumber, 10);
      }
      const editingId = editingAssignmentId;
      const original = editingId ? assignmentsCache.find(item => Number(item.assignment_id) === Number(editingId)) : null;
      if (editingId && (!original || original._operationId)) return;
      const fingerprint = JSON.stringify([editingId, payload]);
      if ([...pendingOperations.values()].some(operation => operation.fingerprint === fingerprint)) {
        AppUI.toast('같은 과제를 저장하고 있습니다. 잠시만 기다려주세요.');
        return;
      }
      const key = 'save-' + (++operationSequence);
      const id = editingId || 'pending-' + operationSequence;
      const optimistic = { ...original, ...payload, assignment_id: id,
        target_grade: original?.target_grade ?? Number(user.grade),
        target_class: original?.target_class ?? Number(user.class_number),
        created_by: original?.created_by ?? Number(user.id), creator_name: original?.creator_name || user.name,
        _operationId: key };
      if (user.is_admin) { optimistic.target_grade = payload.target_grade; optimistic.target_class = payload.target_class; }
      const operation = { key, id, scope, type: editingId ? 'edit' : 'create', original, optimistic, fingerprint, draft,
        index: original ? assignmentsCache.indexOf(original) : 0 };
      pendingOperations.set(key, operation);
      invalidateListLoads();
      listError = '';
      if (original) assignmentsCache.splice(operation.index, 1, optimistic);
      else assignmentsCache.unshift(optimistic);
      resetAssignmentForm();
      operation.clearedRevision = draftRevision;
      operation.clearedDraft = captureDraft();
      renderAssignments();
      try {
        const result = editingId ? await API.updateAssignment(editingId, payload) : await API.createAssignment(payload);
        if (!ownsAssignmentScope(scope)) return;
        if (!result?.success) throw new Error(result?.error || '저장에 실패했습니다. 다시 시도해주세요.');
        const realId = editingId || Number(result.assignment_id);
        if (!Number.isSafeInteger(Number(realId)) || Number(realId) < 1) throw new Error('저장 결과를 확인하지 못했습니다. 다시 불러와 확인해주세요.');
        const index = assignmentsCache.findIndex(item => item._operationId === key);
        const saved = { ...(index >= 0 ? assignmentsCache[index] : optimistic), assignment_id: Number(realId), _saved: true };
        delete saved._operationId;
        if (index >= 0) assignmentsCache.splice(index, 1, saved);
        pendingOperations.delete(key);
        invalidateListLoads();
        confirmedOverrides.set(String(realId), { version: mutationVersion, type: 'save', assignment: saved });
        renderAssignments();
        cacheConfirmedAssignments(scope);
        AppUI.toast(editingId ? '과제 수정이 저장됐어요.' : '새 과제가 저장됐어요.');
        API.refreshNotifications().catch(() => {});
        if (!editingId) dashboardRedirectScope = scope;
        redirectAfterConfirmedRegistration(scope);
      } catch (error) {
        if (!ownsAssignmentScope(scope)) return;
        dashboardRedirectScope = null;
        const index = assignmentsCache.findIndex(item => item._operationId === key);
        if (index >= 0) {
          if (original) assignmentsCache.splice(index, 1, original);
          else assignmentsCache.splice(index, 1);
        }
        pendingOperations.delete(key);
        invalidateListLoads();
        recoverFailedDraft(operation);
        renderAssignments();
        AppUI.toast(error?.message || '저장에 실패했습니다. 다시 시도해주세요.', true);
      }
    });

    document.getElementById('insertImageBtn').addEventListener('click', () => {
      if (imagesEnabled) document.getElementById('taskImageInput').click();
    });

    document.getElementById('taskImageInput').addEventListener('change', async (event) => {
      await uploadImagesToContent(event.target.files);
      event.target.value = '';
    });

    document.getElementById('taskContent').addEventListener('paste', async (event) => {
      if (!imagesEnabled) return;
      const imageFiles = Array.from(event.clipboardData?.items || [])
        .filter(item => item.kind === 'file' && String(item.type || '').startsWith('image/'))
        .map(item => item.getAsFile())
        .filter(Boolean);

      if (imageFiles.length === 0) return;
      event.preventDefault();
      await uploadImagesToContent(imageFiles);
    });

    document.getElementById('assignmentForm').addEventListener('input', () => { draftRevision += 1; });
    document.getElementById('assignmentForm').addEventListener('change', () => { draftRevision += 1; });
    document.getElementById('taskContent').addEventListener('input', renderContentPreview);

    document.getElementById('myAssignments').addEventListener('click', async (event) => {
      const scope = syncAssignmentScope();
      if (!scope) return;
      const button = event.target.closest?.('button') || event.target;
      if (button.classList.contains('retry-my')) { await loadMyAssignments(); return; }
      if (button.classList.contains('restore-draft')) {
        const draft = failedDrafts.get(button.dataset.operation);
        if (!draft || isUploadingTaskImage) return;
        if (!sameDraft(captureDraft(), lastResetDraft)) { AppUI.toast('작성 중인 내용을 먼저 저장한 뒤 복원해주세요.', true); return; }
        failedDrafts.delete(button.dataset.operation);
        restoreDraft(draft);
        renderAssignments();
        return;
      }
      if (isUploadingTaskImage || button.disabled) return;
      const id = Number(button.dataset.id);
      if (!Number.isSafeInteger(id) || id < 1) return;
      const user = API.getUser();
      if (!user) return;
      const assignment = getVisibleAssignments(user, assignmentsCache).find(item => Number(item.assignment_id) === id);
      if (!assignment || assignment._operationId) return;
      if (button.classList.contains('edit-my')) { startEditAssignment(assignment); return; }
      if (!button.classList.contains('delete-my') || !confirm('정말 삭제하시겠습니까?')) return;
      const key = 'delete-' + (++operationSequence);
      const operation = { key, id, scope, type: 'delete', original: assignment, index: assignmentsCache.indexOf(assignment) };
      if (Number(editingAssignmentId) === id) {
        operation.draft = captureDraft();
        resetAssignmentForm();
        operation.clearedRevision = draftRevision;
        operation.clearedDraft = captureDraft();
      }
      pendingOperations.set(key, operation);
      invalidateListLoads();
      assignmentsCache.splice(operation.index, 1);
      renderAssignments();
      try {
        const result = await API.deleteAssignment(id);
        if (!ownsAssignmentScope(scope)) return;
        if (!result?.success) throw new Error(result?.error || '삭제에 실패했습니다.');
        pendingOperations.delete(key);
        invalidateListLoads();
        confirmedOverrides.set(String(id), { version: mutationVersion, type: 'delete' });
        renderAssignments();
        cacheConfirmedAssignments(scope);
        AppUI.toast('과제가 삭제됐어요.');
        API.refreshNotifications().catch(() => {});
        redirectAfterConfirmedRegistration(scope);
      } catch (error) {
        if (!ownsAssignmentScope(scope)) return;
        dashboardRedirectScope = null;
        pendingOperations.delete(key);
        invalidateListLoads();
        if (!assignmentsCache.some(item => Number(item.assignment_id) === id)) assignmentsCache.splice(Math.min(operation.index, assignmentsCache.length), 0, assignment);
        recoverFailedDraft(operation);
        renderAssignments();
        AppUI.toast(error?.message || '삭제에 실패했습니다.', true);
      }
    });

    document.getElementById('cancelEditBtn').addEventListener('click', () => {
      resetAssignmentForm();
    });

    document.getElementById('adminAssignmentGradeFilter').addEventListener('change', async (e) => {
      adminGradeFilter = e.target.value;
      if (adminGradeFilter === 'all') {
        adminClassFilter = 'all';
        document.getElementById('adminAssignmentClassFilter').value = 'all';
      }
      renderAssignments();
    });

    document.getElementById('adminAssignmentClassFilter').addEventListener('change', async (e) => {
      adminClassFilter = e.target.value;
      renderAssignments();
    });

    init().catch(() => AppUI.toast('화면을 불러오지 못했습니다. 다시 시도해주세요.', true));
