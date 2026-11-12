# GitHub Pages 화면 + 맥북 서버

이 소스는 GitHub 기본 주소의 화면과 별도 HTTPS 주소의 맥북 Express/MySQL 서버를 연결합니다. 새 설치에서는 아래 설정을 실제 계정·운영 DB·Google 설정과 연결해야 합니다.

## 구성

```text
학생 브라우저
 ├─ https://insaeng0.github.io/assignment-alarm/ → GitHub Pages
 ├─ Google 학교 계정 → 서버에서 ID 토큰 검증
 └─ HTTPS API 주소 → HTTPS 터널 → 맥북 127.0.0.1:3100 → Express + MySQL
```

Pages에는 HTML/CSS/JS만 올립니다. `.env*`, 서버 코드, DB, 업로드 파일은 공개 배포 산출물에서 제외합니다. API 접근 토큰은 짧게 유지하고 탭의 `sessionStorage`에 저장합니다. 로그인 갱신 자격은 브라우저의 `IndexedDB`에 저장하고, 서버 DB에는 해시만 보관합니다. 갱신할 때마다 자격을 교체하고 사용 중에는 자동 갱신하므로 새 탭·브라우저 재실행·서버 재시작 후에도 로그인이 이어집니다. 타사 쿠키에 의존하지 않습니다. 직접 로그아웃하거나 브라우저 사이트 데이터를 지우면 해제되며, 90일 동안 사용하지 않은 갱신 세션은 만료됩니다.

## 1. Google 웹 클라이언트 확인

Google Cloud Console → API 및 서비스 → 사용자 인증 정보에서 기존 **웹 애플리케이션** 클라이언트 ID를 확인합니다. 비밀키는 프런트에 넣지 않습니다. 승인된 JavaScript 원본에는 다음 값만 등록합니다.

```text
https://insaeng0.github.io
```

`/assignment-alarm/` 경로는 Origin에 넣지 않습니다. 서버와 프런트는 같은 웹 클라이언트 ID를 사용합니다. 기존 학교 제한은 `bssm.hs.kr`이며 Google `email_verified`, `hd`, audience를 서버에서 검증합니다. 학교 Workspace 정책에서 앱 사용을 차단하면 해당 관리자의 허용이 필요합니다.

## 2. 맥북의 공개 HTTPS 주소 준비

Docker Desktop을 실행합니다. 설치된 `cloudflared`로 임시 시험 주소를 만들 수 있습니다.

```sh
cloudflared tunnel --url http://127.0.0.1:3100
```

터미널에 표시되는 실제 `https://…trycloudflare.com` 주소를 다음 단계에 사용합니다. 이 터미널을 닫으면 터널도 종료됩니다. 임시 주소는 재실행 시 바뀔 수 있으므로 바뀔 때마다 서버 설정과 Pages API 주소를 갱신해야 합니다. 장기 운영에는 고정 HTTPS 터널 주소를 준비하세요. 임시 터널은 가동률을 보장하는 호스팅이 아닙니다.

### 연결이 중단됐을 때의 복구

Cloudflare Quick Tunnel의 발급 또는 연결이 응답하지 않으면 설치된 SSH로 `localhost.run` HTTPS 중계를 사용할 수 있습니다. 현재 구성은 별도 계정이나 SSH 개인키 없이 동작합니다.

이미 `.env.mac`을 생성한 맥북에서는 다음 명령으로 중계 프로세스를 실행합니다.

```sh
node scripts/run-mac-tunnel.mjs
```

이 프로세스는 실제 API 응답을 검증한 뒤 GitHub Pages의 공개 API 주소를 갱신하고 배포를 요청합니다. 중계가 끊기거나 무료 주소가 바뀌면 다시 연결합니다. GitHub CLI의 저장소/워크플로 권한이 필요합니다. 브라우저의 기존 API 설정과 오류 캐시는 새 주소로 갱신되며, 연결 실패 화면에서 수동 재시도가 가능합니다.

무료 중계의 주소와 가동률은 보장되지 않습니다. 이 프로세스와 Docker가 실행 중이어야 하며, 고정 주소가 필요한 운영은 정식 터널/고정 도메인 구성이 필요합니다. [localhost.run 공식 안내](https://localhost.run/docs/forever-free)

## 3. 비공개 서버 설정 생성·실행

프로젝트 루트에서 실제 주소와 클라이언트 ID로 실행합니다. 다음 명령의 값은 예시 자리표시자입니다.

```sh
node scripts/configure-mac.mjs --api-origin https://실제-API-호스트 --google-client-id 실제Google웹클라이언트ID.apps.googleusercontent.com --admin-email 운영자학교이메일@bssm.hs.kr --teacher-admins true
docker compose --env-file .env.mac up -d --build
```

생성되는 `.env.mac`은 권한 `600`이며 Git에서 제외됩니다. DB 비밀번호와 JWT 서명키는 무작위로 만들고 출력하지 않습니다. 재실행 시 기존 비밀번호와 고정 공개 인증 네임스페이스 `AUTH_REALM_ID`를 유지합니다. 기존 DB를 가져오는 경우 해당 DB의 자격 증명을 먼저 유지해야 하며, 운영 데이터나 백업을 자동 삭제·초기화하지 않습니다.

`--admin-email`에는 과제·사용자를 관리할 운영자의 실제 학교 이메일을 지정합니다. 이 값이 없거나 학교 이메일 형식이 아니면 설정 생성을 중단합니다. 추가 운영자는 `.env.mac`의 `ADMIN_GOOGLE_EMAILS`에 쉼표로 구분해 지정한 뒤 서버를 재시작하세요. `--teacher-admins true`는 Google로 검증된 `teacher숫자@bssm.hs.kr` 계정에도 관리자 권한을 허용합니다. 다른 문자열 포함·다른 도메인에는 적용하지 않으며 명시적 제외 목록이 우선합니다. 반 소속 승인 기능은 사용하지 않습니다. 학교 계정 가입 시 선택한 학년·반으로 바로 이용하며, 기존 대기 계정도 즉시 이용합니다. Google 로그인은 학교 계정을 확인하며 학년·반은 사용자가 선택한 정보입니다. 학생 관리자(검증된 숫자2자리_숫자 학교 계정)는 자기 반 과제를 개인 완료 표시할 수 있습니다. 교사 관리자와 다른 반 과제는 개인 완료 대상에서 제외합니다.

설정의 핵심은 다음과 같습니다.

```dotenv
NODE_ENV=production
TRUST_PROXY=1
APP_ORIGIN=https://실제-API-호스트
FRONTEND_ORIGIN=https://insaeng0.github.io
PAGES_AUTH_MODE=bearer
AUTH_REALM_ID=설정스크립트가생성한64자리hex
HOST_PORT=3100
ALLOW_TEACHER_NUMBER_ADMINS=true
COOKIE_SAMESITE=lax
```

`TRUST_PROXY=1`은 앱을 loopback에만 연결하고 단일 HTTPS 터널을 통과시키는 구성에 사용합니다. MySQL 포트는 외부에 공개하지 않습니다. `.env.mac`·JWT 서명키·DB 비밀번호·학교 데이터·첨부파일은 저장소에 커밋하지 마세요.

## 4. GitHub Pages 배포

저장소 `insaeng0/assignment-alarm`에서:

1. Settings → Pages → Source를 **GitHub Actions**로 선택합니다.
2. Settings → Secrets and variables → Actions → Variables에 `ASSIGNMENT_API_BASE_URL`을 만들고 실제 HTTPS API Origin을 넣습니다. 이 주소는 공개 설정이며 비밀키가 아닙니다. 같은 위치에 `ASSIGNMENT_AUTH_REALM`을 만들고 `.env.mac`의 `AUTH_REALM_ID`를 넣습니다. 이 값도 공개 식별자이며 터널 주소가 바뀌어도 유지해야 합니다.
3. `.github/workflows/pages.yml`이 있는 변경을 기본 브랜치에 반영합니다.
4. Actions에서 `Publish frontend to GitHub Pages` 실행 결과를 확인합니다. 수동 실행의 `api_base_url`로 API 주소를 지정할 수도 있습니다.

워크플로는 테스트 후 허용 목록의 프런트 파일만 `_site`에 복사하고 공개 API 설정·CSP를 생성합니다. 배포 URL이 반환되고 실제 Google 로그인·학년/반 선택·과제 저장·제출 체크·권한별 첨부파일 조회까지 성공해야 운영 연결이 완료된 것입니다.

## 로그인 유지와 서버 갱신

- 새로 로그인하면 자동 로그인 유지가 기본으로 적용됩니다. 기존 탭 세션은 한 번 다시 Google 로그인하면 갱신 세션을 발급받습니다.
- 페이지에 배포된 고정 `authRealm`과 서버의 공개 설정이 일치해야 갱신 자격을 전송합니다. 터널 주소만 바뀌면 짧은 접근 토큰을 다시 발급받습니다. 배포 설정의 API 주소와 저장소 편집 권한이 신뢰의 기준입니다.
- 갱신 자격은 사용할 때 교체하며, 이미 사용한 자격의 재사용이 확인되면 해당 로그인 묶음을 폐기합니다. 동시에 열린 탭은 잠금으로 갱신을 조정합니다.
- 연결 오류나 서버의 일시적 장애에는 저장된 로그인 정보를 지우지 않습니다. 서버가 복구되면 다시 시도할 수 있습니다.
- 갱신용 DB 테이블만 추가하며 기존 과제·회원·첨부파일은 유지합니다. 변경 적용 전 비공개 DB·첨부파일 백업을 보관하세요.

## 실제 운영 시 확인할 점

- 맥북·Docker·MySQL·터널이 실행 중이어야 합니다. 잠자기·전원 종료·인터넷 단절 시 Pages 화면은 열려도 로그인과 데이터 기능은 멈춥니다.
- 기존 Railway DB·이미지는 GitHub 소스에 포함되지 않습니다. 이전 시 원본 백업을 보존하고 별도로 복구해야 합니다.
- 같은 `insaeng0.github.io` Origin의 다른 프로젝트도 같은 출처이므로 해당 계정의 Pages 콘텐츠와 저장소 편집 권한을 신뢰할 수 있어야 합니다.
- 자동 테스트의 DB·Google 응답은 대역을 사용합니다. 실제 Google/학교 정책·맥북 DB·외부 HTTPS 연결은 별도 실환경 검증 대상입니다.

공식 문서: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [Pages 워크플로](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [Google 로그인 설정](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid), [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/), [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).
