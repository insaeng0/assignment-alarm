# 라즈베리파이 5 8GB에서 운영하기

소규모 과제알리미의 Express 서버와 MySQL을 함께 실행할 수 있습니다. 동시 이용 가능 인원은 집 인터넷 업로드 속도와 이미지 사용량 등에 따라 달라집니다. Pi의 전원이나 집 인터넷이 끊기면 서비스도 중단됩니다.

## 1. 준비

Raspberry Pi OS Lite **64-bit**, 안정적인 전원, 냉각 장치, 유선 LAN을 권장합니다. 장기 DB 저장에는 SSD가 유리합니다. [Pi 5 안내](https://www.raspberrypi.com/products/raspberry-pi-5/)

OS를 업데이트한 뒤 [Docker의 Debian 공식 설치 안내](https://docs.docker.com/engine/install/debian/)를 따라 Docker Engine과 Compose 플러그인을 설치합니다. `docker compose version`이 동작하는지 확인합니다. Docker 권한 설정을 하지 않았다면 아래 Docker 명령에 `sudo`를 붙입니다.

공식 `node:24-alpine`과 `mysql:8.4` 이미지는 ARM64를 지원합니다. [Node 이미지](https://hub.docker.com/_/node/tags?name=24-alpine&page=1), [MySQL 이미지](https://hub.docker.com/_/mysql/tags?name=8.&page=1)

## 2. 도메인 없이 무료 HTTPS 주소 만들기

**Tailscale Funnel**의 개인 비상업 Personal 플랜은 무료입니다. 방문 학생은 Tailscale 앱이나 계정이 필요 없고, 고정 IP나 공유기 포트포워딩도 필요하지 않습니다. `https://기기이름.tailnet이름.ts.net` 주소를 사용합니다. [요금](https://tailscale.com/pricing), [Funnel](https://tailscale.com/docs/features/tailscale-funnel)

[공식 Linux 설치 안내](https://tailscale.com/docs/install/linux)에 따라 Tailscale을 Pi에 설치하고:

```sh
sudo tailscale up
sudo tailscale funnel --bg 3000
tailscale funnel status
```

처음에는 계정 소유자가 Funnel/HTTPS 사용을 관리 화면에서 허용해야 할 수 있습니다. 명령이 표시하는 안내를 따르고 실제 계정의 요금제를 확인합니다. `--bg`는 재부팅 뒤 자동 복귀합니다. 장기 서버는 기기 키 만료 설정도 확인합니다. [CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel), [기기 키 만료](https://tailscale.com/docs/features/access-control/auth-keys)

Funnel은 현재 beta이고 조정할 수 없는 대역폭 제한이 있습니다. 고부하 학교 전체 서비스의 가동률을 보장하는 호스팅은 아닙니다. [제약](https://tailscale.com/docs/features/tailscale-funnel)

## 3. 소스와 환경 변수

```sh
git clone https://github.com/kaneaigonan/assignment-alarm.git
cd assignment-alarm
cp .env.example .env
chmod 600 .env
openssl rand -hex 48
```

출력한 무작위 값을 `JWT_SECRET`에 넣고 `.env`를 실제 값으로 설정합니다.

```dotenv
MYSQL_ROOT_PASSWORD=충분히긴무작위비밀번호
MYSQL_USER=assignment_user
MYSQL_PASSWORD=루트와다른무작위비밀번호
MYSQL_DATABASE=assignment_alarm
JWT_SECRET=openssl로생성한값
GOOGLE_CLIENT_ID=기존Google웹클라이언트ID
ADMIN_GOOGLE_EMAILS=실제관리자학교이메일
NODE_ENV=production
APP_ORIGIN=https://실제기기.실제tailnet.ts.net
TRUST_PROXY=1
ENABLE_ASSIGNMENT_IMAGE_UPLOADS=true
ASSIGNMENT_IMAGE_MAX_STORAGE_MB=512
```

앱은 Pi의 `127.0.0.1:3000`으로만 공개되고 MySQL 3306은 공개하지 않습니다. Tailscale이 HTTPS를 처리하며 앱은 프록시 하나를 신뢰합니다. 포트를 인터넷에 직접 공개하면 이 프록시 설정도 다시 검토해야 합니다.

## 4. Google 로그인 주소 등록

Google Cloud Console의 기존 OAuth 웹 클라이언트에서 **승인된 JavaScript 원본**에 정확한 Funnel HTTPS origin을 추가합니다. 예: `https://pi.tailnet.ts.net`. 경로나 끝의 `/`를 넣지 않습니다. 이 앱은 Google Identity Services ID 토큰 방식이라 임의의 OAuth callback 경로를 만들 필요가 없습니다. [Google 설정](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)

Funnel HTTPS 주소는 Google origin 형식 조건에 맞는 것으로 판단되지만, 실제 Console 등록·학교 계정 로그인 전에는 연동 완료를 보장할 수 없습니다. Google의 브랜드·도메인 검증 정책은 별도로 적용됩니다. [인증 정책](https://developers.google.com/identity/verification/authentication-policy-compliance)

## 5. 실행

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 web
curl http://127.0.0.1:3000/api/health
```

health가 `{"status":"ok"}`인지 확인하고 Funnel 주소에서 학교 로그인·과제 등록·이미지 첨부·제출 체크·관리자 공지·다른 반 접근 차단을 확인합니다. 재부팅 후 DB와 이미지가 남는지도 확인합니다.

MySQL healthcheck 이후 앱이 시작됩니다. `restart: unless-stopped`로 재시작하고 로그는 서비스별 최대 10MB × 3개로 순환합니다.

## 6. 이전과 백업

Railway MySQL volume과 이미지 백업을 먼저 확인합니다. MySQL 8.0에서 옮길 때는 원본을 보존하고 SQL dump/import로 새 8.4 DB에 복원합니다. 기존 `mysql/data`를 바로 8.4에 연결하지 않습니다. [MySQL 업그레이드 준비](https://dev.mysql.com/doc/refman/8.4/en/upgrade-prerequisites.html)

DB는 프로젝트의 `mysql/data`, 이미지는 Docker의 `assignment-images` volume입니다. 기존 이미지 파일명을 변경하지 않고 `/app/uploads/assignment-images`에 복원해야 본문 링크가 유지됩니다.

DB와 이미지를 함께 백업하고 Pi 밖의 개인 보관 장소에도 복사합니다. 백업에는 학생 정보가 포함되므로 GitHub에 올리지 않습니다.

```sh
mkdir -p backups
chmod 700 backups
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysqldump -u "$MYSQL_USER" --single-transaction --no-tablespaces "$MYSQL_DATABASE"' > backups/database.sql
docker compose exec -T web tar -czf - -C /app/uploads assignment-images > backups/images.tar.gz
chmod 600 backups/database.sql backups/images.tar.gz
```

두 백업의 정확한 시점을 맞춰야 한다면 웹 쓰기를 잠시 중단한 뒤 진행합니다. SQL 복원 명령은 아래와 같습니다. 이미 운영 데이터가 있는 DB에는 먼저 별도 백업을 만듭니다.

```sh
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE"' < backups/database.sql
```

관리자 이메일 목록 설정과 재로그인도 확인합니다.
