# GitHub Pages + 고정 Cloudflare Tunnel + Raspberry Pi 4

2026-11-13 현재 운영 구성입니다. 화면은 GitHub Pages에서, 서버·DB·첨부파일은 Ubuntu 24.04 ARM64가 설치된 Raspberry Pi 4에서 실행합니다.

- 화면: https://insaeng0.github.io/assignment-alarm/
- 고정 API 구성: https://assignment-alarm-api.insaeng0.workers.dev
- Pi 작업 경로: /home/ubuntu/seongmin/assignment-alarm
- 내부 API: http://127.0.0.1:3100

```text
브라우저 → GitHub Pages
           ├─ Google 학교 계정 인증
           └─ 고정 Worker HTTPS 주소
                  → 제한한 VPC Service
                  → Pi의 정식 Cloudflare Tunnel
                  → 127.0.0.1:3100의 Express → MySQL / 첨부파일
```

## 실행과 재시작

```sh
cd /home/ubuntu/seongmin/assignment-alarm
docker compose --env-file .env.pi ps
curl -fsS http://127.0.0.1:3100/api/health
curl -fsS https://assignment-alarm-api.insaeng0.workers.dev/api/health
systemctl is-enabled docker assignment-alarm-tunnel
systemctl is-active assignment-alarm-tunnel
sudo journalctl -u assignment-alarm-tunnel --since '10 minutes ago' --no-pager
```

내부와 고정 외부 API 모두 `{"status":"ok"}`를 반환하는지 확인합니다. systemd의 `active` 표시는 프로세스 실행 상태이므로 외부 API 확인을 함께 해야 터널·VPC 연결까지 점검할 수 있습니다.

Docker 컨테이너는 `restart: unless-stopped`로, 정식 터널은 systemd 서비스로 실행합니다. 재연결할 때 같은 터널 ID와 Worker 주소를 사용합니다. 임시 trycloudflare 주소 갱신이나 맥북 실행이 필요하지 않습니다.

```sh
docker compose --env-file .env.pi up -d
sudo systemctl restart assignment-alarm-tunnel
```

서버 코드 갱신 후 웹 서비스만 다시 빌드하려면:

```sh
docker compose --env-file .env.pi up -d --no-deps --build web
```

Worker 코드는 `deploy/worker.mjs`, 배포 설정은 `deploy/wrangler.jsonc`입니다. 소유자의 Cloudflare 로그인 후 `wrangler deploy --config deploy/wrangler.jsonc`로 갱신합니다. 기기 전체 서브넷 대신 VPC Service의 loopback 주소와 HTTP 3100 포트에만 연결합니다. Worker는 `/api/` 및 인증된 첨부파일 경로만 전달합니다.

## 비공개 설정과 데이터

- `.env.pi`: 운영 DB 비밀번호·JWT 서명키 등. 권한 600, Git/ZIP/Pages에서 제외.
- `.runtime/tunnel-token`: 해당 터널을 실행하는 전용 자격. 권한 600.
- `.runtime`: 이전 백업과 검증 자료. 권한 700.
- `mysql/data`: Pi의 영구 MySQL 데이터.
- `assignment-alarm-pi_assignment-images`: Docker 첨부파일 볼륨.

Pi에는 Cloudflare 계정 전체를 관리하는 OAuth 자격을 복사하지 않습니다. 전용 터널 자격만 사용합니다. MySQL 포트는 외부에 공개하지 않고 Express도 Pi의 loopback에만 바인딩합니다. Cloudflare 경계까지 암호화된 QUIC을 사용하며 같은 Pi 내부 마지막 구간은 HTTP입니다.

이전 시 SQL dump와 첨부파일을 함께 복사합니다. 기존 `JWT_SECRET`, `AUTH_REALM_ID`, DB 비밀번호와 첨부파일 이름을 보존합니다. Mac과 Pi에서 별도 DB를 동시에 쓰기 운영하지 않습니다. 원본 실습 프로젝트는 기존 `seongmin` 디렉터리에 그대로 있습니다.

## Google 로그인과 Pages

Google OAuth 승인된 JavaScript 원본은 `https://insaeng0.github.io`를 유지합니다. Google 버튼이 실행되는 화면은 Pages이므로 API 주소만 바꿀 때 새 Google 원본 등록은 필요하지 않습니다.

GitHub 저장소 변수 `ASSIGNMENT_API_BASE_URL`에 고정 Worker origin을 넣고 Pages 워크플로를 실행합니다. `ASSIGNMENT_AUTH_REALM`은 기존 식별자를 유지합니다. 정확한 API 주소와 CSP가 함께 배포됩니다.

## 백업

DB 덤프와 첨부파일을 한 묶음으로 보관하고 Pi 밖의 비공개 장소에도 복사합니다. 아래 절차는 실행마다 새 디렉터리를 만들며, 두 파일의 생성과 검증에 성공한 뒤에만 완료 표시를 남깁니다. 운영 중 두 파일을 순서대로 생성하므로 완전히 같은 시점의 스냅샷은 아닙니다. 최종 이전처럼 정확한 시점 일치가 필요한 경우에는 먼저 쓰기 요청을 중지합니다.

```sh
(
  set -eu
  cd /home/ubuntu/seongmin/assignment-alarm
  umask 077
  mkdir -p .runtime/backups
  assignment_backup_dir=$(mktemp -d ".runtime/backups/manual-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")

  if docker compose --env-file .env.pi exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --no-tablespaces --set-gtid-purged=OFF "$MYSQL_DATABASE"' > "$assignment_backup_dir/database.sql.part" &&
     docker compose --env-file .env.pi exec -T web tar -czf - -C /app/uploads assignment-images > "$assignment_backup_dir/images.tar.gz.part" &&
     test -s "$assignment_backup_dir/database.sql.part" &&
     tar -tzf "$assignment_backup_dir/images.tar.gz.part" > /dev/null
  then
    mv -n "$assignment_backup_dir/database.sql.part" "$assignment_backup_dir/database.sql"
    mv -n "$assignment_backup_dir/images.tar.gz.part" "$assignment_backup_dir/images.tar.gz"
    test ! -e "$assignment_backup_dir/database.sql.part"
    test ! -e "$assignment_backup_dir/images.tar.gz.part"
    : > "$assignment_backup_dir/COMPLETE"
    printf '백업 완료: %s\n' "$assignment_backup_dir"
  else
    printf '백업 실패: %s의 .part 파일을 확인하세요. 이전 백업은 보존됩니다.\n' "$assignment_backup_dir" >&2
    exit 1
  fi
)
```

`COMPLETE`가 있는 디렉터리만 완료된 백업으로 취급합니다. 파일 존재와 압축 검증은 실제 복원 시험을 대신하지 않으므로, 별도의 비공개 임시 DB·첨부파일 경로에서 복원을 주기적으로 확인합니다.

최종 이전 때는 원본 웹 쓰기를 중지하고 마지막 DB·이미지를 복사한 뒤 새 서버만 쓰기 운영합니다. `down -v`, `mysql/data` 삭제, 비밀키 재생성은 기존 데이터나 로그인 유지에 영향을 줄 수 있습니다.

## 확인한 운영 상태 — 2026-11-13

- 고정 Worker API의 `/api/health`가 `{"status":"ok"}`를 반환했습니다.
- VPC Service의 대상이 Pi의 `127.0.0.1`, HTTP 3100 포트임을 확인했습니다.
- `cloudflared 2026.11.0`의 QUIC 연결 4개와 밤사이 자동 재연결을 확인했습니다.
- Pi의 웹·MySQL 컨테이너가 약 9시간 가동된 상태에서 healthy임을 확인했습니다.
- 실제 앱 내 브라우저에서 기존 학교 로그인 세션이 대시보드로 복구됐고, 공개 설정 버전 `485defb1c4f1`이 고정 Worker API를 가리켰습니다. 공개 HTML에 진단 UI가 없음을 확인했습니다.
- Pi 웹 컨테이너를 중지했다가 시작한 뒤 healthy 상태를 확인했고, `assignment-alarm-tunnel` systemd 서비스를 재시작한 뒤 active 상태와 고정 Worker health HTTP 200을 확인했습니다.
- 서비스 재시작 후 실제 앱 내 브라우저에서 달력을 다시 불러왔을 때, 수동 Google 재인증 없이 로그인과 과제 건수 표시가 복구됐습니다.
- Pi에서 Google 공개 서명 인증서 엔드포인트가 HTTP 200과 키 2개를 반환했습니다. 이는 Google 인증서 조회 연결 확인이며 새로운 Google 로그인 전체 흐름의 검증은 아닙니다.
- 이전 Mac의 웹·MySQL 컨테이너와 이 프로젝트의 Docker 네트워크는 제거했습니다. 원본 데이터와 백업은 보존하며, 이 작업의 구형 감독·임시 중계 프로세스도 정확한 명령 식별을 확인한 뒤 종료했습니다.

Pi 전원을 껐다 켜는 재부팅은 검증하지 않았습니다. 서비스 자동 재연결 확인을 기기 재부팅 검증으로 간주하지 않습니다. 새로운 Google 인증 흐름의 전체 재검증과 장기간 가동률은 별도 확인 범위입니다.

## 서비스 특성

Workers VPC는 현재 무료 플랜에서도 제공되는 베타 기능입니다. Worker 무료 플랜의 사용 한도와 Pi의 전원·인터넷 상태가 적용됩니다. 서비스 전체의 무중단이나 무제한 사용을 보장하는 구성은 아닙니다.

공식 문서: [Workers VPC](https://developers.cloudflare.com/workers-vpc/get-started/), [터널과 QUIC 조건](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/), [VPC Service 범위](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/).
