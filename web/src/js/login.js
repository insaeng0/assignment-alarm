let googleClientId = null;
let googleSetupToken = null;
let googleButtonRendered = false;
let googleSignInInFlight = false;
let googleLoadAttempts = 0;
let loadingPublicConfig = false;

function setGoogleUiBusy(isBusy) {
  googleSignInInFlight = isBusy;
  const loginBox = document.getElementById('googleLoginBox');
  const profileButton = document.getElementById('googleProfileBtn');
  const cancelButton = document.getElementById('cancelGoogleSetup');

  if (loginBox) {
    loginBox.style.pointerEvents = isBusy ? 'none' : '';
    loginBox.style.opacity = isBusy ? '0.7' : '';
  }
  if (profileButton) {
    profileButton.disabled = isBusy;
    profileButton.textContent = isBusy ? '처리 중...' : '시작하기';
  }
  if (cancelButton) {
    cancelButton.disabled = isBusy;
    cancelButton.style.pointerEvents = isBusy ? 'none' : '';
    cancelButton.style.opacity = isBusy ? '0.6' : '';
  }
}

async function finalizeGoogleLogin(user) {
  // The successful Google login response already contains the server-verified
  // profile and installed session. Avoid a second network round trip.
  const verified = API.normalizeUser(user);
  if (!verified?.id || !verified.grade || !verified.class_number) {
    showError('로그인 정보를 확인하지 못했습니다. 다시 시도해주세요.');
    return;
  }
  API.setUser(verified);
  window.location.replace(API.landingPage(verified));
}

    function showError(msg, { retryConfig = false } = {}) {
      const el = document.getElementById('authError');
      el.textContent = msg;
      el.style.display = 'block';
      document.getElementById('loginStatus').hidden = true;
      document.getElementById('retryLoginConfig').hidden = !retryConfig;
    }

    function hideError() {
      document.getElementById('authError').style.display = 'none';
      document.getElementById('retryLoginConfig').hidden = true;
    }

    function showLoginForm() {
      hideError();
      document.getElementById('googleProfileForm').style.display = 'none';
      document.getElementById('loginForm').style.display = 'block';
    }

    function showGoogleProfileForm(profile, setupToken) {
      hideError();
      googleSetupToken = setupToken;
      document.getElementById('loginForm').style.display = 'none';
      document.getElementById('googleProfileForm').style.display = 'block';
      document.getElementById('googleProfileName').value = profile?.name || '';
      document.getElementById('googleProfileEmail').value = profile?.email || '';
    }

    function getGoogleApi() {
      return window.google?.accounts?.id || null;
    }

async function handleGoogleCredential(credential) {
  if (googleSignInInFlight) return;
  hideError();
  setGoogleUiBusy(true);
  try {
    const res = await API.googleAuth(credential);
    if (!res || res.error) {
      showError(res?.error || '구글 로그인에 실패했습니다.');
      return;
    }
    if (res.requiresProfile) {
      showGoogleProfileForm(res.profile, res.setupToken);
      return;
    }
    await finalizeGoogleLogin(res.user);
  } catch {
    showError('로그인 중 문제가 생겼습니다. 잠시 후 다시 시도해주세요.');
  } finally {
    setGoogleUiBusy(false);
  }
}

    function renderGoogleLoginIfNeeded() {
      if (!googleClientId || googleButtonRendered) return;

      const api = getGoogleApi();
      if (!api) {
        if (++googleLoadAttempts > 50) { showError('Google 로그인을 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해주세요.'); return; }
        window.setTimeout(renderGoogleLoginIfNeeded, 200);
        return;
      }
      document.getElementById('loginStatus').hidden = true;

      document.getElementById('googleDivider').style.display = 'block';
      document.getElementById('googleLoginBox').style.display = 'block';
      document.getElementById('googleDomainHint').style.display = 'block';
      api.initialize({
        client_id: googleClientId,
        ux_mode: 'popup',
        callback: async (response) => {
          if (!response?.credential) {
            showError('구글 인증 결과를 가져오지 못했습니다.');
            return;
          }
          await handleGoogleCredential(response.credential);
        }
      });
      api.renderButton(
        document.getElementById('googleLoginButton'),
        {
          theme: 'outline',
          size: 'large',
          width: Math.min(340, document.getElementById('googleLoginButton').clientWidth || 280),
          text: 'signin_with',
          shape: 'rectangular'
        }
      );
      googleButtonRendered = true;
    }

    async function loadPublicConfig({ force = false } = {}) {
      if (loadingPublicConfig) return;
      loadingPublicConfig = true;
      const retry = document.getElementById('retryLoginConfig');
      retry.disabled = true;
      const status = document.getElementById('loginStatus');
      status.hidden = false;
      status.textContent = '서버에 연결하고 있습니다…';
      try {
        const config = await API.publicConfig({ force });
        if (config && config.googleClientId) {
          hideError();
          googleClientId = config.googleClientId;
          status.textContent = '학교 Google 로그인을 준비하고 있습니다…';
          renderGoogleLoginIfNeeded();
          return;
        }
        const canRetry = ['NETWORK_ERROR', 'REQUEST_TIMEOUT'].includes(config?.code)
          || (config?.success === false && Number(config.status) >= 500);
        showError(config?.error || '구글 로그인이 아직 설정되지 않았습니다.', { retryConfig: canRetry });
      } finally {
        loadingPublicConfig = false;
        retry.disabled = false;
      }
    }

document.getElementById('retryLoginConfig').addEventListener('click', () => {
  hideError();
  loadPublicConfig({ force: true }).catch(() => showError('로그인 설정을 불러오지 못했습니다. 다시 시도해주세요.'));
});

document.getElementById('cancelGoogleSetup').addEventListener('click', () => {
  if (googleSignInInFlight) return;
  googleSetupToken = null;
  showLoginForm();
});

document.getElementById('googleProfileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (googleSignInInFlight) return;
  hideError();
  if (!googleSetupToken) {
    showLoginForm();
    showError('구글 가입 정보가 만료되었습니다. 다시 로그인해주세요.');
    return;
  }

  setGoogleUiBusy(true);
  try {
    const payload = {
      setupToken: googleSetupToken,
      grade: parseInt(document.getElementById('googleGrade').value, 10),
      class_number: parseInt(document.getElementById('googleClass').value, 10)
    };
    const res = await API.googleRegister(payload);
    if (!res || res.error) {
      showError(res?.error || '구글 가입을 완료하지 못했습니다.');
      return;
    }
    await finalizeGoogleLogin(res.user);
  } catch {
    showError('로그인 중 문제가 생겼습니다. 잠시 후 다시 시도해주세요.');
  } finally {
    setGoogleUiBusy(false);
  }
});

    API.ensureUser().then(data => {
      if (data?.id) {
        API.setUser(data);
        window.location.href = API.landingPage(data);
      }
    }).catch(() => {});

    loadPublicConfig().catch(() => showError('로그인 설정을 불러오지 못했습니다. 새로고침해주세요.'));
