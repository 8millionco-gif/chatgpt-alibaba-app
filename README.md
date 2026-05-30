# Alibaba Buyer Chat Assistant

크롬 확장 프로그램 MVP입니다. 현재 Alibaba 계열 채팅 화면에서 보이는 대화 내용을 읽고, 바이어별 히스토리 요약과 다음 답변 후보를 생성합니다.

## 설치

1. Chrome 주소창에서 `chrome://extensions`를 엽니다.
2. 오른쪽 위의 `Developer mode`를 켭니다.
3. `Load unpacked`를 누르고 이 폴더를 선택합니다.
4. Alibaba 채팅 화면을 연 뒤 확장 프로그램 아이콘을 누릅니다.

## 사용

1. 확장 프로그램에서 설정 버튼을 누릅니다.
2. AI API Endpoint, Model, API Key를 입력합니다.
   - 기본값은 OpenAI 호환 Chat Completions API입니다.
   - 사내 프록시나 Alibaba Cloud/OpenAI 호환 게이트웨이가 있으면 endpoint를 바꿔 사용할 수 있습니다.
3. 답변 언어와 회사/상품 메모를 저장합니다.
4. 채팅 화면에서 `대화 분석`을 누릅니다.
5. 생성된 요약과 답변 후보를 확인하고, 필요한 답변을 복사해 상담창에 붙여넣습니다.

## 현재 MVP 범위

- 현재 페이지의 visible DOM에서 대화 후보 텍스트 추출
- 바이어 이름/키 추정
- 바이어별 요약을 Chrome local storage에 저장
- AI API로 요약, 미해결 항목, 다음 답변 후보 생성
- 자동 전송 없음

## 실사용 전 보완 권장

- 실제 Alibaba 채팅 화면의 DOM 구조에 맞춰 `src/content.js`의 selector 튜닝
- 회사 서버를 통한 API key 보호
- 사용자 로그인과 권한 관리
- 개인정보/거래정보 보관 기간 정책
- Alibaba 서비스 약관 검토
