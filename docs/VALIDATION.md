# 검증 기록

## 현재 운영 확인 — 2026-11-13

운영 대상은 Raspberry Pi 4의 Ubuntu ARM64이며 경로는 `/home/ubuntu/seongmin/assignment-alarm`입니다. 구성과 점검 명령은 [현재 Pi 운영 안내](RASPBERRY_PI.md)에 정리했습니다.

- `curl -fsS https://assignment-alarm-api.insaeng0.workers.dev/api/health`가 `{"status":"ok"}`를 반환했습니다.
- Workers VPC Service가 Pi의 `127.0.0.1`, HTTP 3100 포트로 연결됨을 확인했습니다.
- `cloudflared 2026.11.0`의 QUIC 연결 4개와 밤사이 자동 재연결을 확인했습니다.
- 웹·MySQL 컨테이너는 약 9시간 가동 후 healthy 상태였습니다.
- 실제 앱 내 브라우저에서 기존 학교 로그인 세션이 대시보드로 복구됐습니다. 공개 설정 버전 `485defb1c4f1`이 고정 Worker API를 가리키며, 공개 HTML에 진단 UI가 없음을 확인했습니다.
- Pi 웹 컨테이너를 중지했다가 시작해 healthy를 확인하고, 정식 `assignment-alarm-tunnel` 서비스를 재시작해 active를 확인했습니다. 이후 고정 Worker health가 HTTP 200을 반환했습니다.
- 재시작 후 실제 앱 내 브라우저에서 달력을 새로 불러와 수동 Google 재인증 없이 로그인과 과제 건수 표시가 복구됐습니다.
- Pi에서 `https://www.googleapis.com/oauth2/v1/certs` 조회가 HTTP 200과 공개 키 2개를 반환했습니다. 이는 인증서 조회 연결 확인이며 새 Google 인증 과정 전체를 검증한 결과는 아닙니다.
- 이전 Mac의 웹·MySQL 컨테이너와 프로젝트 Docker 네트워크를 제거했습니다. 원본 데이터·백업은 보존했고, 구형 감독·임시 중계 프로세스는 정확한 명령 식별을 확인한 뒤 종료했습니다.
- Node.js 24의 전체 자동 테스트 156개가 통과했습니다. 대역 기반 회귀 테스트와 위 실운영 확인을 구분합니다.

Pi 전원 재부팅은 검증하지 않았습니다. 새 Google 인증 과정 전체, 브라우저 프로세스를 완전히 종료한 뒤의 재실행, 장기간 가동률을 이번 확인만으로 보장하지 않습니다. 자동 테스트의 Google·DB 대역과 실제 운영 연결 확인도 구분합니다. [소스·보안 회귀 검증 기록](SECURITY_REVIEW.md)을 함께 확인하세요.

---

## 과거 검증 기록 — 2026-10-01

아래 내용은 2026-10-01 당시의 기록이며 현재 Pi 배포 상태를 설명하지 않습니다. 기존 운영 DB와 분리한 임시 데이터로 진행했습니다.

- `npm test`: 23개 통과. Google 표시 이름 계정 탈취, 학교 Workspace claim, 관리자 자동 승격, CSRF, JWT 용도 혼용, 삭제 계정 세션, IDOR, 이미지 URL 권한 세탁, 인코딩 경로 우회, 입력 검증, 트랜잭션 rollback, 동시 대상 변경, API 장애 처리.
- 모든 서버/클라이언트 JavaScript 문법 및 `git diff --check` 통과.
- npm production 의존성 audit: 보고된 취약점 0개. 모든 잠재적 취약점이 없다는 의미는 아닙니다.
- 실제 MySQL 8.4: 과제 CRUD, 반별 목록 격리, 제출 상태, 공지, 알림, 관리자 권한, 삭제 외래키 정리 확인.
- 실제 Chromium: 검색·제출 필터, 제출 상태 저장, 모달/알림 Escape, 1월 31일→2월 이동, 등록·삭제, 관리자 화면, 다크모드 확인. 1440/390/320px 화면의 가로 넘침과 JavaScript 실행 오류 없음.
- ARM64 `node:24-alpine` Docker 이미지 실제 빌드·일반 사용자(node) 실행. MySQL 연결, 첨부 업로드/비공개 접근, HTTPS 프록시 뒤 Secure/HttpOnly 쿠키 확인.
- 이미지 named volume은 웹 컨테이너 재시작 뒤에도 보존됨.
- Compose 구성 검증 통과. 공개 클라우드 배포는 수행하지 않음.

당시에는 실제 Pi의 전원·인터넷·저장장치, Tailscale 주소, Google Console origin 및 학교 계정 로그인을 확인하지 않았습니다. 기존 Railway DB·이미지의 잔존 여부와 실제 복원도 당시 별도 확인 대상으로 남았습니다.
