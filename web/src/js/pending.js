API.requireAuth({ allowPending: true });
let checkingApproval = false;

async function refreshApproval() {
  if (checkingApproval) return;
  const button = document.getElementById('refreshApproval');
  const status = document.getElementById('pendingStatus');
  checkingApproval = true;
  button.disabled = true;
  status.textContent = '승인 상태를 확인하고 있습니다…';
  try {
    const user = await API.ensureUser({ force: true, allowPending: true });
    if (!user) return;
    document.getElementById('pendingName').textContent = user.name || '학교 계정';
    document.getElementById('pendingClass').textContent = `${user.grade}학년 ${user.class_number}반`;
    if (API.hasClassAccess(user)) {
      window.location.replace(API.appPageUrl('calendar.html'));
      return;
    }
    status.textContent = '아직 확인 대기 중입니다. 관리자의 확인 후 다시 눌러주세요.';
  } catch (error) {
    status.textContent = error?.message || '승인 상태를 불러오지 못했습니다. 다시 시도해주세요.';
  } finally {
    checkingApproval = false;
    button.disabled = false;
  }
}

document.getElementById('refreshApproval').addEventListener('click', refreshApproval);
refreshApproval();
