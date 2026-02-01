/**
 * Skill Forge - End-to-End Test
 *
 * Phase 1 완성 테스트
 * Orchestrator + Architect + Discord UI 통합
 */

import { createOrchestrator } from './orchestrator';
import {
  formatCountdownMessage,
  formatProgressMessage,
  formatCompletionMessage,
} from './discord-ui';
import { SkillRequest, SessionPhase } from './types';

async function runE2ETest() {
  console.log('═'.repeat(60));
  console.log('🔥 Skill Forge E2E Test - Phase 1');
  console.log('═'.repeat(60));
  console.log('');

  // 1. Orchestrator 생성
  const orchestrator = createOrchestrator({
    countdownMs: 2000, // 테스트용 2초
  });

  // 2. 이벤트 로깅
  orchestrator.onEvent((event) => {
    console.log(`\n📢 [${event.type}]`);

    switch (event.type) {
      case 'REQUEST_RECEIVED':
        console.log(`   스킬: ${event.request.name}`);
        console.log(`   설명: ${event.request.description}`);
        break;

      case 'AGENT_START':
        console.log(`   ${formatProgressMessage(event.agent as SessionPhase)}`);
        break;

      case 'AGENT_COMPLETE':
        if (event.agent === 'architect') {
          const output = event.output as any;
          console.log(`   ✅ 설계 완료: ${output.skillName}`);
          console.log(`   📋 워크플로우: ${output.workflow.length}단계`);
          console.log(`   📁 파일: ${output.fileStructure.length}개`);
        }
        break;

      case 'COUNTDOWN_START':
        console.log(`   ⏳ ${event.phase} 카운트다운 시작`);
        break;

      case 'COUNTDOWN_EXPIRE':
        console.log(`   ⏰ 카운트다운 만료 - 자동 승인`);
        break;

      case 'SESSION_COMPLETE':
        console.log(`   ${event.success ? '🎉 성공!' : '❌ 실패'}`);
        break;
    }
  });

  // 3. 테스트 요청
  const testRequest: SkillRequest = {
    name: 'weather-check',
    description: '현재 날씨 정보를 조회하고 알려줍니다',
    triggers: ['/weather', '날씨 알려줘', '오늘 날씨'],
    capabilities: ['API 호출', '데이터 파싱', '응답 포맷팅'],
    rawInput: '/forge weather-check - 현재 날씨 정보를 조회하고 알려줍니다',
  };

  console.log('\n📝 테스트 요청:');
  console.log(`   스킬명: ${testRequest.name}`);
  console.log(`   설명: ${testRequest.description}`);
  console.log(`   트리거: ${testRequest.triggers.join(', ')}`);

  // 4. 세션 시작
  console.log('\n' + '─'.repeat(60));
  console.log('🚀 세션 시작...');
  console.log('─'.repeat(60));

  try {
    const state = await orchestrator.startSession(testRequest);

    // 5. Architect 결과 출력 (Discord UI 포맷)
    if (state.artifacts.architectOutput) {
      console.log('\n' + '─'.repeat(60));
      console.log('📱 Discord UI Preview (Architect Review)');
      console.log('─'.repeat(60));

      const discordMessage = formatCountdownMessage('architect_review', 5, state.artifacts);

      console.log('\n' + discordMessage.content);

      console.log('\n🔘 버튼:', discordMessage.components?.[0]?.map((b) => b.label).join(' | '));
    }

    // 6. 전체 파이프라인 대기 (Developer → QA → Complete)
    console.log('\n' + '─'.repeat(60));
    console.log('⏳ 전체 파이프라인 실행 대기 (6초)...');
    console.log('─'.repeat(60));

    await new Promise((resolve) => setTimeout(resolve, 6000));

    // 7. 최종 상태 확인
    const finalState = orchestrator.getState();
    console.log('\n' + '─'.repeat(60));
    console.log('📊 최종 상태');
    console.log('─'.repeat(60));

    console.log(`   Phase: ${finalState?.phase}`);
    console.log(`   Architect: ${finalState?.artifacts.architectOutput ? '✅' : '❌'}`);
    console.log(`   Developer: ${finalState?.artifacts.developerOutput ? '✅' : '❌'}`);
    console.log(`   QA: ${finalState?.artifacts.qaOutput ? '✅' : '❌'}`);

    // 8. 완료 메시지
    if (finalState?.phase === 'completed') {
      console.log('\n' + '─'.repeat(60));
      console.log('📱 Discord UI Preview (Completion)');
      console.log('─'.repeat(60));
      console.log('\n' + formatCompletionMessage(finalState));
    }

    console.log('\n' + '═'.repeat(60));
    console.log('✅ E2E Test 완료!');
    console.log('═'.repeat(60));
  } catch (error) {
    console.error('\n❌ 테스트 실패:', error);
  }

  process.exit(0);
}

// ESM entry point
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runE2ETest();
}
