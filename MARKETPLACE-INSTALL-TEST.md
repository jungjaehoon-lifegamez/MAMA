# 마켓플레이스 설치형 플러그인 테스트 가이드

**목표:** MAMA를 실제 마켓플레이스에서 설치하는 것처럼 테스트

---

## 현재 상태 (2025-11-21)

### ✅ 완료된 설정
- 플러그인 구조: `packages/claude-code-plugin/`
- MCP 서버: `packages/mcp-server/`
- 로컬 링크: `~/.claude/plugins/repos/mama` → `/home/hoons/MAMA/packages/claude-code-plugin`
- 플러그인 활성화: `~/.claude/settings.json`에 `mama@local: true`

### ⚠️ 문제점
**증상:** 다른 프로젝트에서 MAMA MCP 서버가 자동 로드되지 않음

**원인:**
1. 프로젝트별 `.mcp.json`이 있으면 플러그인의 MCP 설정이 무시됨
2. 전역 `~/.claude/mcp.json`과 플러그인의 `.mcp.json` 우선순위 문제

---

## 🧪 테스트 방법

### 1단계: 플러그인 MCP 서버 자동 로드 확인

**목표:** 플러그인의 `.mcp.json`이 모든 프로젝트에서 자동 적용되는지 확인

```bash
# 1. 새 프로젝트 생성 (MCP 설정 없음)
mkdir -p /tmp/clean-test-project
cd /tmp/clean-test-project

# 2. Claude Code 시작
claude-code

# 3. MCP 서버 확인
/mcp
# 예상: mama 서버가 목록에 나타나야 함

# 4. MAMA 명령어 테스트
/mama-list
# 예상: 정상 작동
```

**예상 결과:**
- ✅ mama MCP 서버 자동 로드
- ✅ `/mama-*` 명령어 사용 가능
- ✅ 별도 설정 불필요

**실패 시:**
- ❌ "No MCP servers configured" 메시지
- ❌ `/mama-list` 실패

---

### 2단계: 기존 프로젝트 충돌 테스트

**목표:** 프로젝트별 `.mcp.json`이 있어도 MAMA가 작동하는지 확인

```bash
# 1. .mcp.json이 있는 프로젝트로 이동
cd /home/hoons/spineLiftWASM  # spinelift MCP 서버 설정 있음

# 2. MCP 서버 목록 확인
/mcp
# 예상: spinelift + mama 둘 다 보여야 함

# 3. MAMA 테스트
/mama-list
# 예상: 정상 작동
```

**현재 문제:**
- ❌ 프로젝트별 `.mcp.json`이 있으면 플러그인 MCP 무시됨
- 해결책: 각 프로젝트 `.mcp.json`에 mama 서버 추가 필요 (수동)

---

## 🔧 Claude Code MCP 로딩 우선순위 (추정)

```
1. 프로젝트 루트 .mcp.json (최우선)
   └─ 있으면: 이것만 사용, 다른 설정 무시
   └─ 없으면: 2번으로

2. ~/.claude/mcp.json (전역 사용자 설정)
   └─ 플러그인 MCP와 병합?

3. 플러그인의 .mcp.json (plugin.json의 mcpServers)
   └─ 언제 로드되는지 불명확
```

**문제:** 1번이 있으면 3번이 무시되는 것으로 보임

---

## 🚀 해결 방안

### 방안 A: 플러그인 MCP 우선순위 높이기 (이상적)

**Claude Code 동작 변경 필요:**
```
프로젝트 .mcp.json + 플러그인 .mcp.json 병합
```

**장점:**
- ✅ 한 번 설치하면 모든 프로젝트에서 작동
- ✅ 진정한 "설치형 플러그인"

**단점:**
- ❌ Claude Code 자체 동작이므로 제어 불가

---

### 방안 B: 배포 시 npx 사용 (권장)

**`.mcp.json` 변경:**
```json
{
  "mcpServers": {
    "mama": {
      "command": "npx",
      "args": ["-y", "@spellon/mama-server"],
      "env": {
        "MAMA_DATABASE_PATH": "${HOME}/.claude/mama-memory.db",
        "MAMA_EMBEDDING_MODEL": "Xenova/multilingual-e5-small"
      }
    }
  }
}
```

**장점:**
- ✅ npm 패키지로 배포 가능
- ✅ 사용자가 수동 설치 가능
- ✅ 버전 관리 용이

**설치 방법 (사용자):**
```bash
# 1. 플러그인 설치
/plugin install mama@spellon

# 2. 프로젝트별로 MCP 설정 추가 (수동)
# 또는
# 전역 ~/.claude/mcp.json에 추가 (권장)
```

---

### 방안 C: 설치 스크립트 제공

**`install.sh` 작성:**
```bash
#!/bin/bash
# MAMA 플러그인 설치 후 자동 설정

# 1. 플러그인 설치 확인
echo "Installing MAMA plugin..."
claude plugin install mama@spellon

# 2. 전역 MCP 설정 업데이트
MAMA_MCP_CONFIG='{
  "mama": {
    "command": "npx",
    "args": ["-y", "@spellon/mama-server"]
  }
}'

# 3. ~/.claude/mcp.json에 병합
jq ".mcpServers.mama = $MAMA_MCP_CONFIG" ~/.claude/mcp.json > /tmp/mcp.json
mv /tmp/mcp.json ~/.claude/mcp.json

echo "✅ MAMA installed successfully!"
echo "Restart Claude Code to activate."
```

---

## 📝 현재 권장 설치 방법 (로컬 테스트)

### 방법 1: 전역 MCP 설정 (모든 프로젝트)

```bash
# ~/.claude/mcp.json 편집
{
  "mcpServers": {
    "mama": {
      "command": "node",
      "args": ["/home/hoons/MAMA/packages/mcp-server/src/server.js"],
      "env": {
        "MAMA_DATABASE_PATH": "${HOME}/.claude/mama-memory.db",
        "MAMA_EMBEDDING_MODEL": "Xenova/multilingual-e5-small"
      }
    }
  }
}
```

**장점:**
- ✅ 한 번 설정으로 모든 프로젝트에서 작동
- ✅ `.mcp.json` 없는 프로젝트에서 자동 적용

**단점:**
- ❌ 프로젝트별 `.mcp.json`이 있으면 무시됨

---

### 방법 2: 프로젝트별 추가 (필요한 프로젝트만)

각 프로젝트 `.mcp.json`에 mama 추가:
```json
{
  "mcpServers": {
    "existing-server": { ... },
    "mama": {
      "command": "node",
      "args": ["/home/hoons/MAMA/packages/mcp-server/src/server.js"],
      "env": {
        "MAMA_DATABASE_PATH": "${HOME}/.claude/mama-memory.db"
      }
    }
  }
}
```

**이미 적용된 프로젝트:**
- ✅ `/home/hoons/spineLiftWASM/.mcp.json` (2025-11-21 추가됨)

---

## 🎯 다음 단계

### Phase 3: 배포 준비

1. **npm 패키지 배포**
   ```bash
   cd packages/mcp-server
   npm publish --access public
   # 패키지명: @spellon/mama-server
   ```

2. **플러그인 .mcp.json 업데이트**
   ```json
   {
     "command": "npx",
     "args": ["-y", "@spellon/mama-server"]
   }
   ```

3. **마켓플레이스 배포**
   - GitHub repo: `spellon/claude-plugins`
   - 플러그인 등록: `mama@spellon`

4. **설치 가이드 작성**
   ```bash
   # 사용자 설치 방법
   /plugin marketplace add spellon/claude-plugins
   /plugin install mama@spellon

   # 전역 MCP 설정 (선택)
   # ~/.claude/mcp.json에 mama 서버 추가
   ```

---

## ✅ 체크리스트

로컬 테스트:
- [ ] 새 프로젝트에서 MAMA 자동 로드 확인
- [ ] 기존 프로젝트에서 MAMA 작동 확인
- [ ] 훅 동작 확인 (UserPromptSubmit, PreToolUse)
- [ ] 스킬 동작 확인 (mama-context)

배포 준비:
- [ ] MCP 서버 npm 패키지 빌드
- [ ] `.mcp.json`을 npx 방식으로 변경
- [ ] README 업데이트 (설치 방법)
- [ ] 설치 스크립트 작성
- [ ] 마켓플레이스 제출

---

**작성일:** 2025-11-21
**상태:** 로컬 테스트 중, 자동 로드 이슈 확인
