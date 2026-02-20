# MAMA 스케줄링 (크론잡) 스킬

## 개요

MAMA OS는 내장 스케줄러가 있어 반복 작업을 자동 실행할 수 있음.

## 크론잡 추가 방법

### 방법 1: config.yaml 직접 편집

```yaml
# ~/.mama/config.yaml
scheduling:
  jobs:
    - id: naver_news_hourly
      name: 네이버 뉴스 (매시)
      cron: '0 * * * *'
      prompt: '네이버 뉴스 헤드라인 10개 가져와서 디스코드에 전송'
      enabled: true
```

### 방법 2: API 사용

```bash
# 크론잡 추가
curl -X POST http://localhost:3847/api/scheduling/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "name": "네이버 뉴스",
    "cron_expr": "*/10 * * * *",
    "prompt": "네이버 뉴스 10개 가져와서 디스코드로 전송",
    "enabled": true
  }'

# 크론잡 목록
curl http://localhost:3847/api/scheduling/jobs

# 크론잡 삭제
curl -X DELETE http://localhost:3847/api/scheduling/jobs/{job_id}

# 크론잡 토글 (활성화/비활성화)
curl -X PATCH http://localhost:3847/api/scheduling/jobs/{job_id}/toggle
```

## 크론 표현식 가이드

| 표현식         | 의미          |
| -------------- | ------------- |
| `* * * * *`    | 매분          |
| `*/5 * * * *`  | 5분마다       |
| `*/10 * * * *` | 10분마다      |
| `0 * * * *`    | 매시 정각     |
| `0 9 * * *`    | 매일 오전 9시 |
| `0 9 * * 1-5`  | 평일 오전 9시 |
| `0 0 * * *`    | 매일 자정     |

## 크론잡 프롬프트 작성 팁

### 좋은 예

```
네이버 뉴스 속보 10개를 수집해서 디스코드 채널 {channel_id}로 전송해.
python3 스크립트로 크롤링하고 discord_send 도구로 전송.
```

### 나쁜 예

```
뉴스 보내줘
```

→ 너무 모호함. 어떤 뉴스? 어디로? 몇 개?

## 주의사항

- 크론잡은 MAMA 재시작 시 자동 로드됨
- `enabled: false`로 비활성화 가능
- 복잡한 작업은 스크립트 파일로 분리 권장
- 디스코드 전송 시 채널 ID 명시 필요

## 관련 파일

- 설정: `~/.mama/config.yaml`
- 로그: `~/.mama/logs/daemon.log` (Cron 태그로 필터)
