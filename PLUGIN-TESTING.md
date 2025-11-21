# MAMA 플러그인 로컬 테스트 가이드

## 현재 상황

심볼릭 링크는 생성되었지만 플러그인은 **아직 설치되지 않았습니다**.

```bash
~/.claude/plugins/repos/mama -> /home/hoons/MAMA/packages/claude-code-plugin
```

## 플러그인 설치 방법

Claude Code에서 로컬 플러그인을 테스트하려면 다음 방법 중 하나를 사용하세요:

### 방법 1: /plugin 명령어 사용 (추천)

Claude Code에서:
```
/plugin install local mama
```

또는:
```
/plugin add ~/.claude/plugins/repos/mama
```

### 방법 2: 수동으로 installed_plugins.json 편집

1. 파일 열기:
```bash
nano ~/.claude/plugins/installed_plugins.json
```

2. 다음 내용 추가:
```json
{
  "version": 1,
  "plugins": {
    "hookify@claude-code-plugins": { ... },
    "mama@local": {
      "version": "1.0.0",
      "installedAt": "2025-11-21T13:00:00.000Z",
      "lastUpdated": "2025-11-21T13:00:00.000Z",
      "installPath": "/home/hoons/.claude/plugins/repos/mama",
      "isLocal": true
    }
  }
}
```

3. Claude Code 재시작

### 방법 3: 프로젝트 로컬 .claude 디렉토리 사용

```bash
# 프로젝트 루트에 .claude 디렉토리 생성
mkdir -p /home/hoons/MAMA/.claude

# .mcp.json 복사
cp /home/hoons/MAMA/packages/claude-code-plugin/.mcp.json /home/hoons/MAMA/.mcp.json
```

이 방법은 프로젝트별로 MCP 서버를 설정할 수 있습니다.

## 플러그인 구조 확인

### 필수 파일들:
- ✅ `.claude-plugin/plugin.json` - 플러그인 메타데이터
- ✅ `commands/*.md` - 5개 명령어
- ✅ `.mcp.json` - MCP 서버 설정
- ✅ `scripts/*-hook.js` - 훅 스크립트 (선택)

### 확인:
```bash
ls -la ~/.claude/plugins/repos/mama/.claude-plugin/
ls -la ~/.claude/plugins/repos/mama/commands/
ls -la ~/.claude/plugins/repos/mama/.mcp.json
```

## 테스트 순서

### 1. 플러그인 설치 확인
```bash
cat ~/.claude/plugins/installed_plugins.json | grep mama
```

### 2. Claude Code에서 명령어 확인
타이핑:
```
/mama-
```
자동완성으로 5개 명령어가 나타나야 함:
- `/mama-save`
- `/mama-recall`
- `/mama-list`
- `/mama-suggest`
- `/mama-configure`

### 3. MCP 서버 연결 테스트
```
/mcp
```
mama 서버가 나타나야 함

### 4. 기능 테스트
```
/mama-save test "My first decision" "Testing MAMA plugin"
/mama-list
/mama-recall test
```

## 예상되는 문제들

### 문제 1: MCP 서버 의존성 누락
**증상:**
```
Error: Cannot find module '@modelcontextprotocol/sdk'
```

**해결:**
```bash
cd /home/hoons/MAMA/packages/mcp-server
npm install
# 또는 pnpm install (권장)
```

### 문제 2: 플러그인이 인식되지 않음
**확인:**
```bash
# plugin.json 유효성
cat ~/.claude/plugins/repos/mama/.claude-plugin/plugin.json

# 심볼릭 링크 확인
ls -la ~/.claude/plugins/repos/mama
```

### 문제 3: 명령어가 나타나지 않음
- Claude Code 완전 재시작
- installed_plugins.json 확인
- settings.json에서 플러그인 활성화 확인

## MCP 서버 단독 테스트

플러그인 없이 MCP 서버만 테스트:

```bash
# 서버 실행
cd /home/hoons/MAMA/packages/mcp-server
node src/server.js

# 다른 터미널에서 테스트
echo '{"jsonrpc": "2.0", "id": 1, "method": "initialize"}' | node src/server.js
```

## 다음 단계

플러그인이 설치되면:
1. ✅ 명령어 테스트
2. ✅ MCP 서버 연결 확인
3. ✅ 데이터베이스 생성 확인 (`~/.claude/mama-memory.db`)
4. ✅ 실제 결정 저장/검색 테스트
5. ✅ 훅 동작 테스트 (선택)

---

**작성일:** 2025-11-21
**상태:** 심볼릭 링크 생성 완료, 플러그인 설치 대기 중
