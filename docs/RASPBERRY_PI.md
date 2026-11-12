# GitHub Pages + 고정 Cloudflare Tunnel + Raspberry Pi 4

화면은 GitHub Pages에서, 서버·DB·첨부파일은 Ubuntu 24.04 ARM64가 설치된 Raspberry Pi 4에서 실행합니다.

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
curl http://127.0.0.1:3100/api/health
systemctl is-enabled docker assignment-alarm-tunnel
systemctl is-active assignment-alarm-tunnel
sudo journalctl -u assignment-alarm-tunnel --since '10 minutes ago' --no-pager
```

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

DB와 첨부파일을 같은 시점에 보관하며, Pi 밖의 비공개 장소에도 복사합니다.

```sh
cd /home/ubuntu/seongmin/assignment-alarm
umask 077
mkdir -p .runtime/backups/manual
docker compose --env-file .env.pi exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --no-tablespaces --set-gtid-purged=OFF "$MYSQL_DATABASE"' > .runtime/backups/manual/database.sql
docker compose --env-file .env.pi exec -T web tar -czf - -C /app/uploads assignment-images > .runtime/backups/manual/images.tar.gz
```

최종 이전 때는 원본 웹 쓰기를 중지하고 마지막 DB·이미지를 복사한 뒤 새 서버만 쓰기 운영합니다. `down -v`, `mysql/data` 삭제, 비밀키 재생성은 기존 데이터나 로그인 유지에 영향을 줄 수 있습니다.

## 서비스 특성

Workers VPC는 현재 무료 플랜에서도 제공되는 베타 기능입니다. Worker 무료 플랜의 사용 한도와 Pi의 전원·인터넷 상태가 적용됩니다. 서비스 전체의 무중단이나 무제한 사용을 보장하는 구성은 아닙니다.

공식 문서: [Workers VPC](https://developers.cloudflare.com/workers-vpc/get-started/), [터널과 QUIC 조건](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/), [VPC Service 범위](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/).
