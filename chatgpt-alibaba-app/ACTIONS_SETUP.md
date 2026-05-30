# ChatGPT Actions 설정 메모

이 백엔드는 Custom GPT의 Actions에 붙여 쓰는 것을 우선 목표로 합니다.

## OpenAPI URL

개발 서버:

```text
http://localhost:8787/openapi.json
```

ChatGPT에 연결하려면 공개 HTTPS 배포 후 다음처럼 사용합니다.

```text
https://your-domain.example/openapi.json
```

## 인증

`.env`에서 `APP_SHARED_SECRET`을 설정하면 모든 `/api/*` 엔드포인트는 아래 인증 중 하나를 요구합니다.

```text
Authorization: Bearer <APP_SHARED_SECRET>
```

또는:

```text
x-api-key: <APP_SHARED_SECRET>
```

## ChatGPT에서 요청 예시

```text
이 바이어 대화를 요약하고 적합한 상품 5개를 추천해줘.
바이어: ABC Trading
대화: We need 500 pcs eco-friendly packaging boxes for the US market. Please share MOQ, sample, and delivery time.
언어: English
```

## 다음 단계

- Alibaba OAuth callback 추가
- access token 갱신 저장
- 상품 상세 조회 `alibaba.icbu.product.get` 보강
- 주문/물류 API별 정규화 응답 추가
- Apps SDK용 MCP 서버와 카드형 UI 추가
