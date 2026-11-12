# 검증 기록 — 2026-10-01

기존 운영 DB와 분리한 임시 데이터로 진행했습니다.

- `npm test`: 23개 통과. Google 표시 이름 계정 탈취, 학교 Workspace claim, 관리자 자동 승격, CSRF, JWT 용도 혼용, 삭제 계정 세션, IDOR, 이미지 URL 권한 세탁, 인코딩 경로 우회, 입력 검증, 트랜잭션 rollback, 동시 대상 변경, API 장애 처리.
- 모든 서버/클라이언트 JavaScript 문법 및 `git diff --check` 통과.
- npm production 의존성 audit: 보고된 취약점 0개. 모든 잠재적 취약점이 없다는 의미는 아닙니다.
- 실제 MySQL 8.4: 과제 CRUD, 반별 목록 격리, 제출 상태, 공지, 알림, 관리자 권한, 삭제 외래키 정리 확인.
- 실제 Chromium: 검색·제출 필터, 제출 상태 저장, 모달/알림 Escape, 1월 31일→2월 이동, 등록·삭제, 관리자 화면, 다크모드 확인. 1440/390/320px 화면의 가로 넘침과 JavaScript 실행 오류 없음.
- ARM64 `node:24-alpine` Docker 이미지 실제 빌드·일반 사용자(node) 실행. MySQL 연결, 첨부 업로드/비공개 접근, HTTPS 프록시 뒤 Secure/HttpOnly 쿠키 확인.
- 이미지 named volume은 웹 컨테이너 재시작 뒤에도 보존됨.
- Compose 구성 검증 통과. 공개 클라우드 배포는 수행하지 않음.

실제 Pi의 전원·인터넷·저장장치, Tailscale 주소, Google Console origin 및 학교 계정 로그인은 아직 확인하지 않았습니다. 기존 Railway DB·이미지의 잔존 여부와 실제 복원도 별도 확인이 필요합니다.
