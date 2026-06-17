# ChatGPT Alibaba Account Assistant

ChatGPT에 연결할 수 있는 Alibaba 계정 운영 비서 백엔드 MVP입니다. 기존 REST API와 함께 ChatGPT 앱/커넥터용 MCP 엔드포인트(`/mcp`)를 제공합니다.

## 할 수 있는 일

- Alibaba API 연결 상태 확인
- 내 상품 검색
- 기존 상품 복사 기반 신규 등록 초안 생성
- 신규 등록 전 중복 리스팅 위험 점검
- 사용자 승인 후 Alibaba 신규 상품 등록 실행
- 바이어 대화 요약
- 바이어 대화 기반 추천 상품 리스트 생성
- 상품 URL을 포함한 바이어용 공유 메시지 생성
- 주문 목록 요약 API 뼈대 제공
- ChatGPT 앱 커넥터용 MCP 도구 제공

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
ALIBABA_TOP_APP_KEY=...
ALIBABA_TOP_APP_SECRET=...
ALIBABA_ACCESS_TOKEN=...
ALIBABA_REFRESH_TOKEN=...
ALIBABA_ACCESS_TOKEN_EXPIRES_AT=...
ALIBABA_REFRESH_TOKEN_EXPIRES_AT=...
ALIBABA_AUTH_URL=https://openapi-auth.alibaba.com/oauth/authorize
ALIBABA_GATEWAY=https://eco.taobao.com/router/rest
ALIBABA_REST_GATEWAY=https://openapi-api.alibaba.com/rest
ALIBABA_SELF_ACCOUNT_ID=...
ALIBABA_TOP_SIGN_METHOD=hmac
ALIBABA_IM_CONVERSATION_LIST_METHOD=alibaba.interaction.im.conversation.list.query
ALIBABA_IM_MESSAGE_LIST_METHOD=alibaba.interaction.im.message.list.query
```

`ALIBABA_ACCESS_TOKEN_EXPIRES_AT`과 `ALIBABA_REFRESH_TOKEN_EXPIRES_AT`은 선택값입니다. ISO 날짜 문자열이나 Unix timestamp를 넣을 수 있습니다. 값이 없더라도 상품 검색 중 토큰 만료 오류가 발생하면 서버가 `ALIBABA_REFRESH_TOKEN`으로 한 번 자동 갱신 후 재시도합니다.

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

ChatGPT 앱/MCP 엔드포인트:

```text
http://localhost:8787/mcp
```

## ChatGPT 앱으로 연결하는 방법

Render 배포 후 ChatGPT에서 아래 주소를 커넥터로 추가합니다.

```text
https://chatgpt-alibaba-app.onrender.com/mcp
```

흐름:

```text
ChatGPT Settings
→ Apps & Connectors
→ Advanced settings
→ Developer mode 활성화
→ Connectors에서 Create
→ MCP URL에 https://chatgpt-alibaba-app.onrender.com/mcp 입력
```

새 채팅에서 `+` 또는 More 메뉴로 Alibaba Assistant 커넥터를 추가한 뒤 자연어로 요청합니다.

예시:

```text
알리바바 연결 상태 확인해줘.
화장품 관련 내 상품 5개 찾아줘.
이 상품을 복사해서 미국 바이어용 신규 등록 초안을 만들어줘.
이 바이어 대화를 한국어로 요약하고 다음 답변을 추천해줘.
아래 바이어에게 추천할 상품 3개를 골라주고, 영어 답변과 한국어 번역을 같이 작성해줘.
```

현재 MCP 도구:

- `alibaba_connection_status`
- `refresh_alibaba_access_token`
- `search_alibaba_products`
- `draft_optimized_product_clone`
- `prepare_product_listing_payload`
- `publish_product_listing`
- `summarize_buyer_conversation`
- `list_alibaba_im_conversations`
- `fetch_alibaba_conversation_history`
- `recommend_products_for_buyer`

## ChatGPT Actions로 연결하는 방법

1. 이 서버를 HTTPS 주소로 배포합니다.
2. `.env`의 `BASE_URL`을 배포 주소로 설정합니다.
3. ChatGPT의 Custom GPT 또는 Actions 설정에서 `openapi.json` 주소를 가져옵니다.
4. `APP_SHARED_SECRET`을 설정했다면 Actions 인증에 같은 Bearer 토큰을 넣습니다.

로컬 주소는 ChatGPT가 직접 접근할 수 없으므로, 실제 연결에는 공개 HTTPS 주소가 필요합니다. ChatGPT 앱 방식에서는 `/openapi.json` 대신 `/mcp`를 사용합니다.

## 주요 엔드포인트

- `GET /api/alibaba/status`
- `POST /mcp`
- `GET /api/alibaba/oauth/authorize-url`
- `POST /api/alibaba/oauth/refresh`
- `POST /api/products/search`
- `POST /api/products/clone-draft`
- `POST /api/products/listing/prepare`
- `POST /api/products/listing/publish`
- `POST /api/buyer/summary`
- `POST /api/buyer/conversations`
- `POST /api/buyer/history`
- `POST /api/buyer/recommend-products`
- `POST /api/orders/brief`

## 추천 기능 흐름

```text
바이어 대화 또는 conversation_id 입력
→ Alibaba IM 메시지 조회
→ Alibaba 상품 목록 조회
→ 대화 키워드와 상품 매칭
→ 추천 이유, 다음 확인 질문, 바이어용 답변, 한국어 번역 생성
→ ChatGPT에 추천 상품 URL 표시
```

## Alibaba 토큰 오류 해결

`IllegalAccessToken`이 나오면 access token이 만료되었거나 refresh token까지 만료된 상태입니다.

1. 먼저 연결 상태를 확인합니다.

```text
https://chatgpt-alibaba-app.onrender.com/api/alibaba/status
```

2. `tokenHealth.reauthorization_required`가 `true`이면 재인증 URL을 확인합니다.

```text
https://chatgpt-alibaba-app.onrender.com/api/alibaba/oauth/authorize-url
```

3. `authorize_url`을 브라우저에서 열어 Alibaba 승인을 완료합니다.
4. callback 화면에 표시된 `code`로 `/api/alibaba/oauth/token`을 호출해 새 토큰을 발급합니다.
5. Render 환경변수의 아래 값을 새 값으로 교체한 뒤 재배포합니다.

```text
ALIBABA_ACCESS_TOKEN
ALIBABA_REFRESH_TOKEN
ALIBABA_ACCESS_TOKEN_EXPIRES_AT
ALIBABA_REFRESH_TOKEN_EXPIRES_AT
```

서버는 access token 오류가 발생하면 refresh token으로 1회 자동 갱신 후 재시도합니다. refresh token까지 만료되면 응답에 `reauthorization_required`, `authorize_url`, `callback_url`을 포함합니다.

ChatGPT 앱 안에서 즉시 갱신을 시도하려면 아래처럼 요청합니다.

```text
알리바바 access token을 수동 갱신해줘.
```

이 기능은 서버 메모리의 토큰을 갱신하고 만료 예정 시간을 확인합니다. 원본 토큰 값은 ChatGPT 응답에 노출하지 않습니다. Render 서비스가 재시작된 뒤에도 새 토큰을 유지하려면 OAuth 재인증 또는 별도 저장소 연동으로 Render 환경변수를 업데이트해야 합니다.

## 다음 개발 우선순위

1. 완료: 바이어 대화 기반 추천 답변 품질 개선
   - 추천 상품, 추천 이유, 다음 확인 질문, 바이어용 답변, 한국어 번역을 한 번에 반환합니다.
2. 완료: 상품 검색 결과 표시 개선
   - 상품명, 상태, 이미지, URL, 상품 ID를 표/카드/복사용 URL 목록 형태로 제공합니다.
3. 완료: 기존 상품 복사 기반 신규 등록 초안
   - 원본 상품을 기준으로 제목, 키워드, 상세 구성, 중복 위험, 등록 전 확인 항목을 생성합니다.
   - 실제 상품 등록/수정 API는 호출하지 않는 초안 전용 기능입니다.
4. 진행: Alibaba IM 대화 히스토리 API 검증
   - `list_alibaba_im_conversations`로 `conversation_id`를 찾고, `fetch_alibaba_conversation_history`로 오래된 메시지까지 timestamp 기반으로 조회합니다.
5. 완료: 상품 신규 등록 승인 흐름
   - `prepare_product_listing_payload`로 등록 전 누락 항목과 payload를 확인합니다.
   - `publish_product_listing`은 `execute=true`와 `confirmation_phrase=등록 실행`이 있어야만 `/alibaba/icbu/product/listing/v2`를 호출합니다.
6. 토큰/보안 운영 고도화
   - secret 교체, refresh token 만료 알림, 안전한 저장소 도입을 검토합니다.
7. ChatGPT 앱 UI 컴포넌트 추가
   - 추천 상품을 ChatGPT 안에서 카드형 UI로 보여주는 화면을 추가합니다.

## 주의

- Alibaba `app_secret`, `access_token`은 브라우저 확장 프로그램이나 ChatGPT 프롬프트에 넣지 말고 서버 환경 변수에만 보관해야 합니다.
- `ALIBABA_REFRESH_TOKEN`을 설정하면 access token 만료 시 서버 메모리에서 자동 갱신합니다. Render가 재시작되면 환경변수에 저장된 refresh token으로 다시 갱신합니다.
- 상품 조회는 권한 승인된 REST API `/alibaba/icbu/product/list`를 `ALIBABA_REST_GATEWAY`로 호출합니다. `ALIBABA_GATEWAY`는 일부 기존 TOP 방식 API가 필요할 때 사용합니다.
- Alibaba IM 조회는 TOP API 문서 기준 `params` JSON 파라미터와 `hmac` 서명을 사용합니다. 이 API는 문서상 사용자 authorization이 필수가 아니므로 기본값은 `include_session=false`입니다.
- IM API에서 `Invalid app Key`가 나오면 현재 GGS-ISV `ALIBABA_APP_KEY`가 TOP 게이트웨이에서 유효하지 않은 상태입니다. Alibaba에서 TOP/OKKI&TM 앱 키를 별도 발급받은 뒤 `ALIBABA_TOP_APP_KEY`, `ALIBABA_TOP_APP_SECRET`에 넣어야 합니다.
- 기존 상품 복사 기반 신규 등록 초안은 중복 리스팅 위험을 낮추기 위한 검토 도구입니다. 실제 신규 등록 전에는 이미지, 제목, 속성, 가격, MOQ, 배송 템플릿, 효능 표현을 사람이 확인해야 합니다.
- 실제 신규 상품 등록은 명시 승인 방식입니다. `confirmation_phrase`가 정확히 `등록 실행`이고 `execute=true`일 때만 Alibaba 등록 API를 호출합니다.
- 상품 수정, 주문 수정, 배송 처리 같은 쓰기 작업은 사용자 확인 단계를 둔 뒤 추가하는 것이 안전합니다.
- 현재 MVP는 읽기/추천 중심입니다.

## ChatGPT 앱 테스트 문장

```text
알리바바에서 blemish 상품 5개를 검색하고, 표와 복사용 URL 목록으로 정리해줘.
```

```text
알리바바 access token을 수동 갱신하고, 연결 상태를 다시 확인해줘.
```

```text
이 바이어 대화를 바탕으로 적합한 상품 5개를 추천하고, 바이어에게 보낼 영어 답변과 한국어 번역을 같이 작성해줘.
```

```text
알리바바 IM 대화 목록을 10개 조회해서 conversation_id와 최근 메시지 시간을 표로 보여줘.
```

```text
conversation_id가 [여기에 입력]인 알리바바 대화 히스토리를 2페이지까지 조회하고 전체 흐름을 한국어로 요약해줘.
```

```text
상품 ID 10000031929376을 복사해서 미국 바이어용 private label blemish care 신규 등록 초안을 만들고, 중복 위험과 등록 전 확인 항목을 같이 보여줘.
```

```text
방금 만든 신규 등록 초안을 기준으로 등록 payload를 준비하고 부족한 항목을 알려줘.
```

```text
아래에 붙여넣은 Alibaba 상품 등록용 payload 초안을 검토해서 실제 등록 전 부족한 항목과 안전한 등록 payload로 변환해줘.
```

```text
최종 등록 정보가 맞는지 확인했어. confirmation_phrase는 등록 실행이고 execute=true로 Alibaba 신규 상품 등록을 실행해줘.
```
