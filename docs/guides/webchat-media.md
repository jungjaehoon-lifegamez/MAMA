# Webchat Media Guide

MAMA Viewer(웹챗)에서 이미지 업로드/다운로드 및 TTS/STT 사용법.

## Image Upload

### Attach Button

채팅 입력창 아래 📎 버튼 클릭 또는 파일을 채팅 영역에 드래그 & 드롭.

### Supported Formats

- **Images**: JPEG, PNG, GIF, WebP, SVG
- **Documents**: PDF
- **Max size**: 20MB (5MB 초과 시 자동 압축)

### How It Works

1. 파일 선택 → 미리보기 썸네일 표시
2. 메시지 입력 (선택사항, 기본값: "What is in this image?")
3. Send → 파일이 `/api/upload`로 업로드
4. WebSocket으로 이미지를 base64 변환 후 Claude에 전달
5. Claude가 이미지 내용을 인식하여 응답

## Image Download

Claude 응답에 `~/.mama/workspace/media/outbound/` 경로의 파일이 포함되면 자동으로:

- 이미지: 인라인으로 표시 + 다운로드 링크
- 기타 파일: 다운로드 링크

## TTS (Text-to-Speech)

### Toggle

채팅 헤더의 스피커 아이콘 클릭으로 ON/OFF.

### Features

- 스트리밍 응답 완료 시 자동 음성 출력
- 속도 조절: 0.5x ~ 2.0x (기본 1.8x, 한국어 최적화)
- 핸즈프리 모드: TTS 종료 후 자동으로 음성 입력 시작

## STT (Speech-to-Text)

### Usage

마이크 버튼 클릭 → 음성 입력 → 2.5초 침묵 시 자동 종료.

- **연속 인식**: 여러 문장을 이어서 말할 수 있음
- **언어**: 브라우저 언어 설정 자동 감지 (한국어/영어)

## API Reference

### POST /api/upload

```http
Content-Type: multipart/form-data
Body: file (binary)

Response: { success, filename, mediaUrl, size, contentType }
```

### GET /api/media/:filename

파일 인라인 표시 (이미지 등).

### GET /api/media/download/:filename

파일 강제 다운로드 (`Content-Disposition: attachment`).

## WebSocket Protocol

이미지 첨부 시 메시지 형식:

```json
{
  "type": "send",
  "sessionId": "...",
  "content": "이 이미지에 뭐가 있어?",
  "attachments": [
    {
      "filename": "photo.jpg",
      "contentType": "image/jpeg"
    }
  ]
}
```

> **Security Note**: 서버는 클라이언트가 제공하는 `filePath`를 **무시**하고, `filename`만 사용하여 `~/.mama/workspace/media/inbound/` 내에서 파일을 찾습니다. 이는 Local File Inclusion (LFI) 공격을 방지합니다.

서버에서 `attachments`를 base64 `contentBlocks`로 변환하여 Claude Vision API에 전달합니다.
