# 무료 배포 후보

2026-10-01 공식 문서 기준입니다. 현재 앱은 Express, MySQL, 학교 로그인 및 이미지 저장을 사용합니다.

남는 **라즈베리파이 5 8GB + Docker + 무료 HTTPS 터널**이 있으면 서버·DB·이미지를 집에서 함께 보관할 수 있습니다. 클라우드 월 사용료는 들지 않지만 전기·집 인터넷 비용과 직접 관리가 필요합니다. [Pi 안내](RASPBERRY_PI.md)

## GitHub 무료 배포

**GitHub Pages는 무료 정적 웹사이트 호스팅이 맞습니다.** GitHub Free에서는 공개 저장소를 사용할 수 있지만 Express와 MySQL을 실행하지는 못합니다. 앱 전체를 그대로 배포할 수 없고 로그인·과제 저장·공지에는 별도 서버가 필요합니다. [Pages 공식 안내](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)

## 클라우드 대안

| 선택지 | 무료 범위와 제약 | 추가 작업 |
|---|---|---|
| Render + Aiven MySQL | Render 15분 유휴 절전, 첫 재가동 약 1분. Aiven MySQL DB 1GB·카드 없이 기한 제한 없음, 장기 미사용 중단 가능 | 현재 서버 유지, DB TLS·새 Google origin·이미지 저장 변경 |
| Cloudflare Workers + D1 | 정적 자산 무료, API 10만/일, D1 DB당 500MB 및 일일 읽기/쓰기 제한 | 서버 실행 방식과 MySQL SQL 이식 |
| Vercel + Aiven + 외부 이미지 저장 | 개인 비상업 Hobby 무료, Express 지원, 함수 요청 전체 4.5MB 제한 | 서버리스 연결·공유 rate limit·이미지 직접 업로드 변경 |

[Render 무료](https://render.com/docs/free), [Aiven 무료 MySQL](https://aiven.io/docs/products/mysql/concepts/mysql-free-tier), [Workers 한도](https://developers.cloudflare.com/workers/platform/limits/), [D1 한도](https://developers.cloudflare.com/d1/platform/limits/), [Vercel Express](https://vercel.com/docs/frameworks/backend/express), [Hobby](https://vercel.com/docs/plans/hobby), [함수 제한](https://vercel.com/docs/functions/limitations)

Render 무료 Postgres는 30일 만료이므로 영구 과제 저장소로 사용하지 않습니다. 로컬 업로드도 절전·재배포 때 보존되지 않습니다. `render.yaml`은 **새 이미지 업로드를 꺼 둔 템플릿**이며 기존 이미지를 복구하거나 외부 저장소를 연동한 상태는 아닙니다.

Cloudinary 무료 플랜은 카드 없이 월 25 credits이며 저장 GB·전송 GB·변환을 함께 계산합니다. 연동은 별도로 구현해야 합니다. 학교 첨부파일을 기본 공개 CDN으로 옮기면 로그인 없이 보이므로 `authenticated` 자산과 권한 확인 전달 방식을 사용해야 합니다. [가격](https://cloudinary.com/pricing), [크레딧](https://cloudinary.com/documentation/billing_and_plans), [접근 제어](https://cloudinary.com/documentation/control_access_to_media)

## Railway 데이터

결제 중단만으로 DB 삭제를 단정하지 않습니다. Railway 공식 FAQ는 미결제로 deployment를 제거해도 연결된 volume은 제거하지 않는다고 안내합니다. 기존 DB volume·백업·이미지 volume 유무를 확인한 뒤 이전하세요. GitHub에는 운영 데이터가 없습니다. [Railway FAQ](https://docs.railway.com/pricing/faqs)

이번 소스 개선은 기존 운영 데이터를 변경하지 않았고 외부 서비스 가입·실제 공개 배포·Railway 데이터 복원도 수행하지 않았습니다.
