# 학교 밖에서 라파 코드 수정

원격 편집 주소:

https://vscode.dev/tunnel/assignment-alarm-pi/home/ubuntu/seongmin/assignment-alarm

GitHub `insaeng0` 계정으로 로그인합니다. 탐색기에서 파일을 열어 수정하고, 터미널에서 라파 명령을 실행할 수 있습니다. 라파의 전원과 인터넷 연결이 필요합니다. 기존 `ssh ubuntu@10.150.1.0`은 학교 내부망용 주소로 유지됩니다. 이 원격 편집 연결은 Mac 전체에 학교 사설망 경로를 만드는 VPN이 아닙니다. 기존 Mac 일일 SSH 백업도 라파 내부 주소에 접속할 수 있을 때 실행된다는 조건을 유지합니다.

## 설치 상태

- 공식 VS Code CLI 1.146.0: `/home/ubuntu/seongmin/tools/vscode-cli/code`
- 비공개 CLI 데이터: `/home/ubuntu/seongmin/tools/vscode-cli/data`
- Ubuntu 사용자 서비스: `code-tunnel.service`
- 서비스 enabled/active, 자동 재시도, 사용자 linger 활성화
- 비공개 디렉터리 700, 일반 데이터 파일 600, 서비스 UMask 0077
- 본인 GitHub 인증을 사용하며 익명 접속이나 공개 포트 전달은 설정하지 않음
- VS Code의 신뢰 범위는 `/home/ubuntu/seongmin/assignment-alarm` 폴더만 적용

서비스가 자동 시작되도록 구성했지만 기기 전원 재부팅 시험은 수행하지 않았습니다. 2026-11-18 브라우저에서 실제 원격 파일 목록과 bash 터미널의 `pwd` 출력을 확인했습니다. 집 와이파이로 물리적으로 전환하는 시험은 수행하지 않았습니다.

## 관리

라파의 Ubuntu 터미널에서 실행합니다.

```sh
systemctl --user status code-tunnel.service
systemctl --user restart code-tunnel.service
```

원격 편집 연결만 중지하려면:

```sh
systemctl --user stop code-tunnel.service
```

과제 알리미 웹·DB와 Cloudflare API 터널은 별도 서비스입니다.

## 수정한 코드 보존과 배포

Pi 폴더는 운영 복사본이며, 현재 독립된 Git 저장소가 아닙니다. 상위 `/home/ubuntu/seongmin`은 다른 기존 Git 저장소이므로 그 저장소에 과제 알리미 파일을 무작정 추가하지 않습니다. 원격 수정분은 Mac의 과제 알리미 저장소에도 동기화해 검토·커밋한 뒤 배포합니다. 이후 Mac 소스를 Pi에 덮어쓰기 전에는 원격 수정 여부를 먼저 대조하고 보존합니다.

백엔드 수정 후에는 Mac 백업 및 소스 검토를 마친 뒤 웹 컨테이너만 재구축합니다.

```sh
cd /home/ubuntu/seongmin/assignment-alarm
docker compose --env-file .env.pi up -d --no-deps --build --force-recreate web
```

GitHub Pages 화면 수정은 저장소에 반영하고 Pages 배포를 완료해야 공개 화면에 적용됩니다. DB·첨부 볼륨 삭제나 비밀키 재생성은 필요하지 않습니다.

Cloudflare Zero Trust 신규 플랜 활성화는 진행하지 않았고, 기존 공개 API 구성은 유지했습니다. [공식 Remote Tunnels 안내](https://code.visualstudio.com/docs/remote/tunnels)
