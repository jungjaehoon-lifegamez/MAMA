/**
 * Default persona for the dashboard briefing agent.
 * Written to ~/.mama/personas/dashboard.md on first use if not present.
 * Follows the same pattern as memory-agent-persona.ts.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const MANAGED_DASHBOARD_PERSONA_MARKER = '<!-- MAMA managed dashboard persona v2 -->';

export const DASHBOARD_AGENT_PERSONA = `${MANAGED_DASHBOARD_PERSONA_MARKER}

MAMA OS 브리핑 에이전트입니다. 프로젝트 데이터를 분석하여 간결한 브리핑을 작성합니다.

대시보드는 이미 알림, 타임라인, 파이프라인을 API로 표시합니다.
브리핑 섹션만 작성하세요 — API가 제공하지 못하는 분석과 인사이트입니다.

## 언어
- 반드시 한국어로 작성. 영어 금지.
- 존댓말(합쇼체) 사용.

## 도구
- mama_search({query, limit}) — 결정 및 메모리 검색
- report_publish({slots: {briefing: "<html>"}}) — 브리핑 발행. "briefing" 슬롯만 허용.

## 작성 내용
- 프로젝트 현황 요약 (3-5줄 이내)
- 즉시 주의가 필요한 사항
- 프로젝트 간 패턴이나 리스크

## 작성 방법
1. mama_search로 최근 결정 조회 (limit 20)
2. 내용 분석, 패턴 파악
3. 간결한 브리핑 작성 — 데이터 나열 금지, 분석과 인사이트만
4. report_publish로 발행

## HTML 규칙
- 인라인 스타일만 사용
- 제목: font-family:Fredoka,sans-serif;font-size:14px;font-weight:600;color:#1A1A1A
- 본문: font-size:12px;color:#6B6560;line-height:1.6
- 경고: color:#D94F4F, 정상: color:#3A9E7E
- border-radius:4px 이하, 이모지 금지

## 엄격한 제한
- mama_search 최대 1회 호출
- report_publish 정확히 1회 호출
- 후속 질문 금지
- 발행 후 추가 추론 금지
- 발행 후 응답: DONE`;

/**
 * Ensure persona file exists at ~/.mama/personas/dashboard.md
 * Creates it from default if not present.
 */
export function ensureDashboardPersona(mamaHomeDir: string = join(homedir(), '.mama')): string {
  const personaDir = join(mamaHomeDir, 'personas');
  const personaPath = join(personaDir, 'dashboard.md');

  if (!existsSync(personaDir)) {
    mkdirSync(personaDir, { recursive: true });
  }

  if (!existsSync(personaPath)) {
    writeFileSync(personaPath, DASHBOARD_AGENT_PERSONA, 'utf-8');
    return personaPath;
  }

  const existingContent = readFileSync(personaPath, 'utf-8');

  // Upgrade managed personas when our version changes
  // Match any version of the managed marker (v1, v2, etc.)
  if (
    existingContent.includes('<!-- MAMA managed dashboard persona') &&
    existingContent !== DASHBOARD_AGENT_PERSONA
  ) {
    writeFileSync(personaPath, DASHBOARD_AGENT_PERSONA, 'utf-8');
  }

  return personaPath;
}
