# 보안 점검 기록 — 2026-11-12

## 수정한 문제

| 항목 | 수정과 검증 |
| --- | --- |
| 요청 처리 라이브러리 DoS | body-parser 1.20.9, qs 6.16.2로 패치. 잘못된 압축 요청 후에도 서버가 생존하는 회귀 테스트 |
| 다른 사용자의 로그인 강제 해제 | 사용자별 최대 5개 세션만 교체. 전체 용량 초과는 503으로 거절하고 타인의 세션은 보존 |
| 학년·반 자기 신고만으로 비공개 데이터 접근 | 관리자의 반 소속 승인 필요. 기존 학생도 승인 전 대기. API·첨부파일에서 서버가 차단 |
| 승인과 반 이동 사이의 경쟁 조건 | 관리자 변경은 트랜잭션·행 잠금. 요청 중 프로필을 다시 읽어도 미승인 소속은 접근 거절 |
| GitHub Pages와 API 분리 인증 | 명시한 HTTPS 프런트 Origin, 제한한 CORS/프리플라이트, CSRF 검사. Pages는 단기 Bearer 방식 |
| 토큰 노출 범위 | 탭 sessionStorage만 사용. 정확한 API Origin으로만 전송하고 리디렉션은 거절. 로그아웃·만료·재시작 시 무효화 |
| 비공개 첨부 이미지 | 인증 fetch → Blob. 서버의 과제 열람 권한 유지. DOM 제거·페이지 종료 시 Blob 해제 |
| Pages의 스크립트·iframe 공격 | 빌드 시 CSP·리퍼러 정책. iframe 인증 동작 차단. HTML/URL은 이스케이프·프로토콜 검사 |
| 배포 파일의 비밀정보 노출 | 정적 파일 허용 목록 사용. .env·서버·DB·업로드 제외. Mac 설정은 파일 권한 600 |
| 빌드 폴더 삭제 범위 | 비어 있거나 이 빌더가 만든 출력 폴더만 교체. 다른 파일이 있으면 중단 |
| 신규 설치의 관리자 부재 | 실제 학교 관리자 이메일을 필수 입력. 첫 가입자 자동 승격 없음 |

기존의 Google audience/email_verified/학교 hd 검사, 관리자 이메일 허용 목록, DB 역할 재확인, SQL 매개변수, 입력·이미지 검증, 타인 계정·과제 권한 검사도 유지하고 회귀 테스트했습니다.

## 검증 결과

- Node 24: 웹·서버·Pages 회귀 테스트 61개 통과
- Mac 비공개 설정 생성 테스트 2개 통과
- 전체 JS 구문 검사 통과
- 실행 시점의 npm audit --omit=dev: 알려진 취약점 0건
- 브라우저: 데스크톱/모바일/다크모드와 예시 데이터의 달력·검색·필터·제출 체크·공지·설정 확인

DB·Google API 응답은 자동 테스트에서 대역을 사용합니다. 실제 학교 Google OAuth·운영 DB·외부 HTTPS 배포는 아직 검증 완료가 아닙니다. 알려진 취약점 검사 0건은 미발견 취약점이나 실환경 설정 오류까지 없음을 뜻하지 않습니다.

## 운영자가 유지할 경계

- 관리자 이메일 목록에 실제로 반 소속을 확인할 운영자만 지정합니다.
- 기존 학생 계정도 실제 반을 확인한 뒤 승인해야 합니다.
- GitHub Pages와 같은 Origin의 다른 프로젝트·저장소 편집자는 신뢰할 수 있어야 합니다.
- 서버·MySQL·비공개 첨부파일과 백업을 공개 디렉터리에 두지 않습니다.
- Quick Tunnel 주소가 바뀌면 API 설정을 갱신합니다. 맥북 잠자기·전원·네트워크 단절 시 서버 기능은 멈춥니다.

근거: [body-parser GHSA](https://github.com/advisories/GHSA-27r3-jxmh-p828), [qs GHSA](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw), [Google GSI CSP](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid#content_security_policy).
