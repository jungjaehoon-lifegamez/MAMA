# MAMA 로컬 마켓플레이스 설치 가이드

**날짜:** 2025-11-21
**목적:** MAMA 플러그인을 로컬 개발용 마켓플레이스로 설치

---

## ✅ 완료된 설정 (2025-11-21 23:54)

### 1. 로컬 마켓플레이스 생성

```bash
# 마켓플레이스 디렉토리 생성
mkdir -p ~/.claude/plugins/marketplaces/mama-local/plugins

# MAMA 플러그인 링크
ln -sf /home/hoons/MAMA/packages/claude-code-plugin \
  ~/.claude/plugins/marketplaces/mama-local/plugins/mama
```

**구조:**
```
~/.claude/plugins/marketplaces/mama-local/
└── plugins/
    └── mama -> /home/hoons/MAMA/packages/claude-code-plugin/
```

### 2. 마켓플레이스 등록

**파일:** `~/.claude/plugins/known_marketplaces.json`

```json
{
  "mama-local": {
    "source": {
      "source": "local",
      "path": "/home/hoons/MAMA"
    },
    "installLocation": "/home/hoons/.claude/plugins/marketplaces/mama-local",
    "lastUpdated": "2025-11-21T14:54:00.000Z"
  }
}
```

### 3. 플러그인 설치 정보

**파일:** `~/.claude/plugins/installed_plugins.json`

```json
{
  "plugins": {
    "mama@mama-local": {
      "version": "1.0.0",
      "installedAt": "2025-11-21T13:00:00.000Z",
      "lastUpdated": "2025-11-21T14:54:00.000Z",
      "installPath": "/home/hoons/.claude/plugins/marketplaces/mama-local/plugins/mama"
    }
  }
}
```

### 4. 플러그인 활성화

**파일:** `~/.claude/settings.json`

```json
{
  "enabledPlugins": {
    "mama@mama-local": true
  }
}
```

---

## 🧪 테스트 방법

### 1. Claude Code 재시작

**중요:** 플러그인 변경사항을 적용하려면 완전히 재시작해야 합니다.

```bash
# Claude Code 완전 종료
pkill -f "claude-code"

# 3초 대기
sleep 3

# Claude Code 재시작
claude-code
```

### 2. 플러그인 명령어 확인

새 세션에서:
```
/help
```

**예상 결과:**
```
/mama-save      - Save decision to MAMA
/mama-recall    - Recall decision history
/mama-suggest   - Suggest related decisions
/mama-list      - List all decisions
/mama-configure - Configure MAMA settings
```

### 3. MCP 서버 확인

```
/mcp
```

**예상 결과:**
```
mama - MAMA - Memory-Augmented MCP Assistant (local development)
```

### 4. 기능 테스트

```bash
# 1. 의사결정 목록 보기
/mama-list

# 2. 새 의사결정 저장
/mama-save

# 3. 검색
/mama-suggest "authentication strategy"
```

---

## 🔍 문제 해결

### 플러그인이 로드되지 않음

**증상:**
- `/help`에 `/mama-*` 명령어가 없음
- `/mcp`에 mama 서버가 없음

**해결:**

1. **심볼릭 링크 확인:**
   ```bash
   ls -la ~/.claude/plugins/marketplaces/mama-local/plugins/mama
   # 응답: ... -> /home/hoons/MAMA/packages/claude-code-plugin
   ```

2. **plugin.json 확인:**
   ```bash
   cat ~/.claude/plugins/marketplaces/mama-local/plugins/mama/.claude-plugin/plugin.json
   # 응답: {"name": "mama", "version": "1.0.0", ...}
   ```

3. **디버그 로그 확인:**
   ```bash
   tail -100 ~/.claude/debug/latest | grep -i "mama\|plugin"
   ```

   **성공 시:**
   ```
   [DEBUG] Loaded plugins - Enabled: 1, Commands: 5
   [DEBUG] Plugin mama@mama-local loaded successfully
   ```

   **실패 시:**
   ```
   [DEBUG] Plugin mama not found in marketplace mama-local
   [DEBUG] Plugin loading errors: ...
   ```

### MCP 서버 연결 실패

**증상:**
- `/mama-list` 실행 시 "Failed to connect to MCP server"

**해결:**

1. **MCP 서버 경로 확인:**
   ```bash
   cat ~/.claude/plugins/marketplaces/mama-local/plugins/mama/.mcp.json
   # args 항목 확인: "/home/hoons/MAMA/packages/mcp-server/src/server.js"
   ```

2. **서버 수동 실행 테스트:**
   ```bash
   node /home/hoons/MAMA/packages/mcp-server/src/server.js
   # 예상: [MAMA MCP] Server started successfully
   ```

3. **의존성 설치 확인:**
   ```bash
   cd /home/hoons/MAMA/packages/mcp-server
   npm install
   ```

---

## 📦 다른 컴퓨터에 설치하기

### 자동 설치 스크립트

```bash
#!/bin/bash
# install-mama-local.sh

MAMA_REPO="/home/hoons/MAMA"
MARKETPLACE_DIR="$HOME/.claude/plugins/marketplaces/mama-local"

# 1. 마켓플레이스 디렉토리 생성
mkdir -p "$MARKETPLACE_DIR/plugins"

# 2. 플러그인 링크
ln -sf "$MAMA_REPO/packages/claude-code-plugin" "$MARKETPLACE_DIR/plugins/mama"

# 3. known_marketplaces.json 업데이트
jq '. + {
  "mama-local": {
    "source": {
      "source": "local",
      "path": "'$MAMA_REPO'"
    },
    "installLocation": "'$MARKETPLACE_DIR'",
    "lastUpdated": "'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'"
  }
}' ~/.claude/plugins/known_marketplaces.json > /tmp/marketplaces.json
mv /tmp/marketplaces.json ~/.claude/plugins/known_marketplaces.json

# 4. installed_plugins.json 업데이트
jq '.plugins += {
  "mama@mama-local": {
    "version": "1.0.0",
    "installedAt": "'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'",
    "lastUpdated": "'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'",
    "installPath": "'$MARKETPLACE_DIR'/plugins/mama"
  }
}' ~/.claude/plugins/installed_plugins.json > /tmp/installed.json
mv /tmp/installed.json ~/.claude/plugins/installed_plugins.json

# 5. settings.json 업데이트
jq '.enabledPlugins += {"mama@mama-local": true}' ~/.claude/settings.json > /tmp/settings.json
mv /tmp/settings.json ~/.claude/settings.json

echo "✅ MAMA 로컬 마켓플레이스 설치 완료!"
echo "Claude Code를 재시작해주세요."
```

### 수동 설치 (위 단계 1-4 참조)

---

## 🚀 프로젝트별 사용

### .mcp.json이 없는 프로젝트

**자동 작동!** 전역 `~/.claude/mcp.json` 설정 사용

```bash
cd ~/new-project
# Claude Code에서
/mama-list  # 바로 작동
```

### .mcp.json이 있는 프로젝트

**수동 추가 필요:**

```bash
# 프로젝트 .mcp.json 편집
{
  "mcpServers": {
    "existing-server": { ... },
    "mama": {
      "command": "node",
      "args": ["/home/hoons/MAMA/packages/mcp-server/src/server.js"],
      "env": {
        "MAMA_DATABASE_PATH": "${HOME}/.claude/mama-memory.db",
        "MAMA_EMBEDDING_MODEL": "Xenova/multilingual-e5-small",
        "NODE_ENV": "development"
      }
    }
  }
}
```

---

## 📊 설치 확인 체크리스트

- [ ] 마켓플레이스 디렉토리 존재: `~/.claude/plugins/marketplaces/mama-local/`
- [ ] 플러그인 링크 정상: `plugins/mama -> .../claude-code-plugin`
- [ ] `known_marketplaces.json`에 `mama-local` 등록됨
- [ ] `installed_plugins.json`에 `mama@mama-local` 등록됨
- [ ] `settings.json`에 `mama@mama-local: true` 설정됨
- [ ] Claude Code 재시작 완료
- [ ] `/help`에 `/mama-*` 명령어 표시됨
- [ ] `/mcp`에 mama 서버 표시됨
- [ ] `/mama-list` 정상 작동

---

## 🎯 다음 단계

### Phase 3: npm 배포 준비

로컬 테스트 완료 후:

1. **MCP 서버 npm 패키지 빌드**
   ```bash
   cd packages/mcp-server
   npm publish --access public
   # 패키지명: @spellon/mama-server
   ```

2. **플러그인 .mcp.json 변경**
   ```json
   {
     "mcpServers": {
       "mama": {
         "command": "npx",
         "args": ["-y", "@spellon/mama-server"]
       }
     }
   }
   ```

3. **마켓플레이스 배포**
   - GitHub repo: `spellon/claude-plugins`
   - 플러그인 추가: `plugins/mama/`

4. **사용자 설치 방법**
   ```bash
   /plugin marketplace add spellon/claude-plugins
   /plugin install mama@spellon
   ```

---

**작성일:** 2025-11-21 23:54
**상태:** 로컬 마켓플레이스 설정 완료, 재시작 대기 중
