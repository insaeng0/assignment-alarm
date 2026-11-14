# 신규 가입 명단 연결

명단은 학교 Google 계정으로 처음 가입할 때 반 선택을 돕습니다. 이름은 소속 증명이나 인증 수단이 아닙니다. 기존의 학생 자기 반 선택 정책을 대체하는 승인제도 아닙니다. 기존 회원은 `google_sub`로 먼저 찾으며, 명단이나 Google 표시 이름으로 기존 학년·반을 변경하지 않습니다.

신규 학생의 확인된 학교 이메일이 `26_숫자@bssm.hs.kr` 형식이면 2026학년도 1학년 범위만 조회합니다. 학년도는 한국 시간 3월 1일에 바뀝니다. `25_...`는 2026학년도 2학년입니다. 해당 학년 명단 또는 같은 이름이 없으면 기존 수동 선택을 유지하며, 교사와 관리자 계정도 수동 선택을 사용합니다. 사진 행 순서를 학번이나 이메일 번호로 해석하지 않습니다.

같은 이름 후보가 하나면 반을 채운 뒤 기존 시작하기 버튼으로 확정합니다. 여러 후보면 본인 반을 선택합니다. 다른 이름 후보·전체 명단·누가 연결했는지는 공개하지 않습니다. 이미 모두 연결된 동명 후보는 수동 선택으로 우회하지 않고 연결 충돌을 알립니다. 이름은 NFKC 및 공백 제거만 적용하고 유사 이름을 추정하지 않습니다.

## 비공개 명단 입력

`web/import-roster.js`는 표준 입력으로 다음 구조의 JSON을 받습니다. 값은 아래의 가상 예시처럼 이름과 반만 사용합니다. 사진·원본 JSON·실제 명단을 Git이나 `web/src`에 넣지 마세요.

```json
{"academic_year":2026,"grade":1,"entries":[{"name":"가상 학생","class_number":1}]}
```

입력은 **해당 학년도·학년 전체 명단의 스냅샷**입니다. 같은 반에서 정규화 이름까지 같은 중복 행은 오류로 처리합니다. 그런 실제 동명이인이 있다면 명단을 구분할 추가 식별자 계약부터 정해야 하며 행 번호로 구분하지 않습니다. OCR 결과의 이름·반·누락은 운영자가 원본과 비교한 뒤 입력해야 합니다.

백엔드 시작 시 명단 테이블이 생성된 뒤, 같은 DB 환경으로 다음과 같이 실행합니다. 컨테이너에는 CLI가 포함됩니다. 명령줄에 명단 내용을 직접 넣지 않습니다.

```sh
docker compose --env-file .env.pi exec -T web node import-roster.js < /private/operator/path/roster.json
```

로컬에서는 DB 환경을 이미 주입한 상태에서 `node web/import-roster.js < /private/operator/path/roster.json`을 사용할 수 있습니다. 별도 Google·JWT 설정은 CLI에 필요하지 않습니다. 출력은 건수와 revision뿐이며 오류도 코드와 0부터 시작하는 행 위치만 반환합니다. 원본 이름·DB 오류 세부 정보는 출력하지 않습니다.

운영 Mac에는 사용자 사진과 대조·확인한 2026학년도 1학년 64명(각 반 16명)의 JSON을 `.runtime/roster/2026-grade1.json`에 권한 600으로 보관합니다. 이 파일과 확인 기록은 Git에서 제외되며 실제 이름을 소스·테스트·Pages 산출물에 포함하지 않습니다. 운영 Pi SSH가 닿지 않아 아직 운영 DB에 입력하지 않았습니다. 새 백엔드를 적용한 후 Mac의 프로젝트 루트에서 다음처럼 비공개 표준 입력으로 보낼 수 있습니다.

```sh
ssh ubuntu@10.150.1.0 'cd /home/ubuntu/seongmin/assignment-alarm && docker compose --env-file .env.pi exec -T web node import-roster.js' < .runtime/roster/2026-grade1.json
```

해당 JSON을 별도의 네트워크 없는 임시 MySQL 8.4에 입력하여 반별 인원·재입력·동명이인 선택·입력 변조 거절·동시 연결 충돌·기존 회원 소속 보존을 확인했습니다. 이는 운영 반영 확인과 구분합니다. 실제 운영 입력 후에는 DB가 포함되는 Mac 백업을 다시 실행합니다.

전체 입력을 검증한 뒤 하나의 트랜잭션으로 반영합니다. 동일 입력은 순서가 달라도 같은 revision을 갖습니다. 기존 행의 UUID와 연결은 보존하며, 새 스냅샷에서 빠진 행은 비활성화만 합니다. 이미 연결된 사용자나 연결 기록은 importer가 삭제·재배정하지 않습니다. 이름/반 교정으로 다른 행이 생겨도 기존 회원 반이 바뀌지는 않습니다.

## 서버 계약과 보호

Google 가입 응답은 `requiresProfile`, `setupToken`, `profile`에 더해 `rosterCandidates: [{roster_id, grade, class_number, name}]`, `rosterRequired`, `rosterAmbiguous`를 제공합니다. 같은 이름의 현재 명단 행이 여러 개면 `rosterAmbiguous`가 true입니다. 다른 행이 이미 연결되어 선택 가능한 후보가 하나만 남아도 이 값은 true이므로 본인 반을 명시적으로 선택합니다. 연결한 계정이나 다른 행의 세부 정보는 공개하지 않습니다. 후보 필수 여부와 학년도·학년은 짧은 setup JWT에도 서명합니다. 명단 전체는 토큰에 포함하지 않습니다.

가입 요청은 `setupToken`, 선택한 `roster_id`, 표시된 `grade/class_number`를 보냅니다. 서버가 현재 명단과 서명된 Google 프로필 이름을 다시 조회하고, 반은 DB 후보에서 정합니다. 변조한 반이나 다른 이름의 UUID는 거절합니다. 후보가 있으면 ID 누락으로 수동 가입할 수 없습니다. 계정 생성과 명단 연결은 동일 트랜잭션에서 잠금·유일 제약으로 보호하며, 중복 연결은 409입니다. 세션 발급이 나중에 실패해도 회원과 연결은 함께 저장되어 다시 로그인할 수 있습니다.

`ROSTER_SELECTION_REQUIRED`/`ROSTER_SELECTION_INVALID`는 400, `ROSTER_ALREADY_CLAIMED`/`ROSTER_CHANGED`는 409입니다. 기존 Google 회원이 이미 있으면 이 선택 절차를 반복하지 않습니다.
