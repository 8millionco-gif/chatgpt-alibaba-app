# ChatGPT Alibaba Account Assistant

ChatGPT Actions에 연결할 수 있는 Alibaba 계정 운영 비서 백엔드 MVP입니다. 현재 크롬 확장 프로그램과 별도로 동작하며, 나중에 같은 API를 ChatGPT Apps SDK UI나 기존 확장 프로그램에서 같이 사용할 수 있습니다.

## 할 수 있는 일

- Alibaba API 연결 상태 확인
- 내 상품 검색
- 바이어 대화 요약
- 바이어 대화 기반 추천 상품 리스트 생성
- 상품 URL을 포함한 바이어용 공유 메시지 생성
- 주문 목록 요약 API 뼈대 제공

## 실행

```powershell
cd C:\Users\doyeo\Documents\Codex\2026-05-28\https-openapi-alibaba-com-doc-api\chatgpt-alibaba-app
copy .env.example .env
```

`.env`에 필요한 값을 입력합니다.

```text
OPENAI_API_KEY=...
ALIBABA_APP_KEY=...
ALIBABA_APP_SECRET=...
ALIBABA_ACCESS_TOKEN=...
ALIBABA_SELF_ACCOUNT_ID=...
```

실행:

```powershell
.\start.ps1
```

상태 확인:

```text
http://localhost:8787/health
```

ChatGPT Actions 스키마:

```text
http://localhost:8787/openapi.json
```

## ChatGPT에 연결하는 방법

1. 이 서버를 HTTPS 주소로 배포합니다.
2. `.env`의 `BASE_URL`을 배포 주소로 설정합니다.
3. ChatGPT의 Custom GPT 또는 Actions 설정에서 `openapi.json` 주소를 가져옵니다.
4. `APP_SHARED_SECRET`을 설정했다면 Actions 인증에 같은 Bearer 토큰을 넣습니다.

로컬 주소는 ChatGPT가 직접 접근할 수 없으므로, 실제 연결에는 공개 HTTPS 주소가 필요합니다.

## 주요 엔드포인트

- `GET /api/alibaba/status`
- `POST /api/products/search`
- `POST /api/buyer/summary`
- `POST /api/buyer/recommend-products`
- `POST /api/orders/brief`

## 추천 기능 흐름

```text
바이어 대화 또는 conversation_id 입력
→ Alibaba IM 메시지 조회
→ Alibaba 상품 목록 조회
→ 대화 키워드와 상품 매칭
→ OpenAI가 추천 이유와 공유 메시지 작성
→ ChatGPT에 추천 상품 URL 표시
```

## 주의

- Alibaba `app_secret`, `access_token`은 브라우저 확장 프로그램이나 ChatGPT 프롬프트에 넣지 말고 서버 환경 변수에만 보관해야 합니다.
- 상품 수정, 주문 수정, 배송 처리 같은 쓰기 작업은 사용자 확인 단계를 둔 뒤 추가하는 것이 안전합니다.
- 현재 MVP는 읽기/추천 중심입니다.
