---
name: 당근마켓 모니터링
description: 당근마켓에서 원하는 매물을 검색하고 조건에 맞는 결과를 알려줍니다
keywords:
  - 당근
  - 당근마켓
  - 중고
  - 매물
  - 중고거래
  - daangn
output: text
---

# 당근마켓 모니터링 스킬

당근마켓 웹에서 키워드 검색 후 가격/상태 조건에 맞는 매물을 필터링하여 알려줍니다.

## 지시사항

1. 사용자 메시지에서 **검색 키워드**와 **최대 가격**(있으면)을 추출합니다.
2. fetch 도구로 당근마켓 검색 URL에 접속합니다:
   - URL: `https://www.daangn.com/search/${encodeURIComponent(키워드)}`
3. 응답 HTML에서 **JSON-LD** (`<script type="application/ld+json">`) 블록을 찾습니다.
   - `@type: "ItemList"` 내의 `itemListElement` 배열을 파싱합니다.
   - 각 항목에서 `name`, `offers.price`, `offers.url`, `offers.availability` 추출
4. 필터링:
   - `availability`가 `InStock`인 항목만 포함 (SoldOut/Reserved 제외)
   - 최대 가격이 지정된 경우 해당 금액 이하만 포함
5. 결과를 아래 형식으로 보고합니다.

## JSON-LD 파싱 예시

```json
{
  "@type": "ItemList",
  "itemListElement": [
    {
      "@type": "ListItem",
      "item": {
        "@type": "Product",
        "name": "스팀덱 독",
        "offers": {
          "price": "15000",
          "priceCurrency": "KRW",
          "url": "https://www.daangn.com/articles/...",
          "availability": "https://schema.org/InStock"
        }
      }
    }
  ]
}
```

## JSON-LD가 없는 경우

HTML에서 JSON-LD를 찾지 못하면 페이지의 매물 목록 텍스트를 직접 읽고 요약합니다.

## 출력 형식

```
🥕 당근마켓 검색: {키워드}
{최대 가격이 있으면: 💰 조건: {maxPrice}원 이하}

📦 매물 {N}건

1. {상품명} - {가격}원
   🔗 {URL}

2. {상품명} - {가격}원
   🔗 {URL}

---
검색 없음 시: "조건에 맞는 매물이 없습니다."
```

## 크론 모니터링 용도

이 스킬이 크론으로 반복 실행될 때:

- 이전에 알림한 URL을 기억하고 **신규 매물만** 보고
- 신규 매물이 없으면 응답하지 않음 (빈 응답)
- 신규 매물 발견 시 "🆕 새 매물 발견!" 접두사 추가

## 주의사항

- Discord 메시지 길이 제한 (2000자) 고려하여 상위 10건만 표시
- 가격은 숫자만 추출하여 비교 (쉼표, "원" 등 제거)
- 검색 실패 시 에러를 명확히 보고
