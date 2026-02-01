/**
 * Skill Forge - Discord UI
 *
 * 5초 카운트다운 + 버튼 인터페이스
 * 실시간 메시지 업데이트 지원
 */

import { SessionState, SessionPhase, ArchitectOutput, DeveloperOutput, QAOutput } from './types';

// ===== Discord Embed Types =====

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number; // Decimal color
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  footer?: {
    text: string;
    icon_url?: string;
  };
  timestamp?: string;
}

// Colors
const COLORS = {
  primary: 0x5865f2, // Discord blurple
  success: 0x57f287, // Green
  warning: 0xfee75c, // Yellow
  danger: 0xed4245, // Red
  architect: 0x3498db, // Blue
  developer: 0x9b59b6, // Purple
  qa: 0x2ecc71, // Emerald
};

// ===== Message Formatters =====

export interface DiscordMessage {
  content: string;
  embeds?: DiscordEmbed[];
  components?: DiscordButton[][]; // 버튼 행들
}

export interface DiscordButton {
  type: 'button';
  label: string;
  style: 'primary' | 'secondary' | 'success' | 'danger';
  customId: string;
  emoji?: string;
  disabled?: boolean;
}

// ===== Real-time Update Manager =====

export interface MessageUpdateManager {
  messageId: string | null;
  channelId: string;
  lastUpdate: number;

  update(message: DiscordMessage): Promise<void>;
  send(message: DiscordMessage): Promise<string>;
}

export function createMessageManager(channelId: string): MessageUpdateManager {
  return {
    messageId: null,
    channelId,
    lastUpdate: 0,

    async update(message: DiscordMessage): Promise<void> {
      // Discord API rate limit: ~5 updates/second
      const now = Date.now();
      if (now - this.lastUpdate < 200) {
        return; // Skip if too fast
      }
      this.lastUpdate = now;

      if (this.messageId) {
        console.log(`[Discord] Update message ${this.messageId}`);
        // Would call discord_edit here
      }
    },

    async send(message: DiscordMessage): Promise<string> {
      console.log(`[Discord] Send to ${this.channelId}`);
      // Would call discord_send here
      this.messageId = 'msg_' + Date.now();
      return this.messageId;
    },
  };
}

// ===== Countdown UI =====

export function formatCountdownMessage(
  phase: SessionPhase,
  secondsRemaining: number,
  artifacts: SessionState['artifacts']
): DiscordMessage {
  let content = '';

  switch (phase) {
    case 'architect_review':
      content = formatArchitectReview(artifacts.architectOutput!, secondsRemaining);
      break;
    case 'developer_review':
      content = formatDeveloperReview(artifacts.developerOutput!, secondsRemaining);
      break;
    case 'qa_review':
      content = formatQAReview(artifacts.qaOutput!, secondsRemaining);
      break;
    default:
      content = `⏳ 검토 중... (${secondsRemaining}초)`;
  }

  return {
    content,
    components: [getReviewButtons()],
  };
}

function formatArchitectReview(output: ArchitectOutput, seconds: number): string {
  const complexity = {
    simple: '🟢 Simple',
    medium: '🟡 Medium',
    complex: '🔴 Complex',
  }[output.estimatedComplexity];

  const workflowSteps = output.workflow
    .map((w) => `  ${w.step}. **${w.action}** - ${w.description}`)
    .join('\n');

  const files = output.fileStructure.map((f) => `  📄 \`${f.path}\` - ${f.purpose}`).join('\n');

  const tools = output.toolsRequired.map((t) => `\`${t}\``).join(', ');

  return `## 🏗️ Architect 설계 완료

**스킬명:** \`${output.skillName}\`
**목적:** ${output.purpose}
**복잡도:** ${complexity}

### 📋 워크플로우
${workflowSteps}

### 📁 파일 구조
${files}

### 🔧 필요 도구
${tools}

---
⏳ **${seconds}초 후 자동 승인** (Developer 단계로 진행)

> 🔘 **Approve** - 이 설계로 진행
> 🔄 **Revise** - 다시 설계 요청
> ❌ **Cancel** - 작업 취소`;
}

function formatDeveloperReview(output: DeveloperOutput, seconds: number): string {
  if (!output.files.length) {
    return `## 💻 Developer 작업 완료

⚠️ 아직 파일이 생성되지 않았습니다 (Phase 2에서 구현 예정)

---
⏳ **${seconds}초 후 자동 승인** (QA 단계로 진행)`;
  }

  const fileList = output.files.map((f) => `  📄 \`${f.path}\` (${f.language})`).join('\n');

  return `## 💻 Developer 작업 완료

### 📁 생성된 파일
${fileList}

### 📦 설치 방법
${output.installInstructions.map((i) => `\`\`\`bash\n${i}\n\`\`\``).join('\n') || '없음'}

### 🧪 테스트 명령
${output.testCommands.map((c) => `\`${c}\``).join(', ') || '없음'}

---
⏳ **${seconds}초 후 자동 승인** (QA 단계로 진행)`;
}

function formatQAReview(output: QAOutput, seconds: number): string {
  const status = output.passed ? '✅ PASSED' : '❌ FAILED';
  const recommendation = {
    approve: '🟢 승인 권장',
    revise: '🟡 수정 권장',
    reject: '🔴 거부 권장',
  }[output.recommendation];

  const checklist = output.checklist.length
    ? output.checklist
        .map((c) => `  ${c.passed ? '✅' : '❌'} ${c.item}${c.note ? ` - ${c.note}` : ''}`)
        .join('\n')
    : '  (체크리스트 없음)';

  const issues = output.issues.length
    ? output.issues
        .map((i) => {
          const icon = { critical: '🔴', warning: '🟡', suggestion: '🔵' }[i.severity];
          return `  ${icon} ${i.description}${i.location ? ` @ ${i.location}` : ''}`;
        })
        .join('\n')
    : '  없음';

  return `## 🔍 QA 검증 완료

**상태:** ${status}
**권장:** ${recommendation}

### ✅ 체크리스트
${checklist}

### ⚠️ 이슈
${issues}

---
⏳ **${seconds}초 후 자동 완료**`;
}

// ===== Button Definitions =====

function getReviewButtons(seconds?: number): DiscordButton[] {
  const isUrgent = seconds !== undefined && seconds <= 2;

  return [
    {
      type: 'button',
      label: 'Approve',
      style: 'success',
      customId: 'skill_forge_approve',
      emoji: '✅',
    },
    {
      type: 'button',
      label: 'Revise',
      style: 'primary',
      customId: 'skill_forge_revise',
      emoji: '🔄',
    },
    {
      type: 'button',
      label: isUrgent ? '⚡ Extend!' : 'Extend +5s',
      style: isUrgent ? 'danger' : 'secondary',
      customId: 'skill_forge_extend',
      emoji: '⏰',
    },
    {
      type: 'button',
      label: 'Cancel',
      style: 'danger',
      customId: 'skill_forge_cancel',
      emoji: '❌',
    },
  ];
}

// ===== Progress Messages =====

export function formatProgressMessage(phase: SessionPhase): string {
  const messages: Record<SessionPhase, string> = {
    idle: '⏸️ 대기 중...',
    architect: '🏗️ **Architect**가 스킬 구조를 설계하고 있습니다...',
    architect_review: '👀 **구조 검토 중** (카운트다운)',
    developer: '💻 **Developer**가 코드를 작성하고 있습니다...',
    developer_review: '👀 **코드 검토 중** (카운트다운)',
    qa: '🔍 **QA**가 품질을 검증하고 있습니다...',
    qa_review: '👀 **검증 결과 검토 중** (카운트다운)',
    completed: '🎉 **스킬 생성 완료!**',
    cancelled: '❌ **작업이 취소되었습니다**',
  };

  return messages[phase];
}

// ===== Completion Message =====

export function formatCompletionMessage(state: SessionState): string {
  const { artifacts, request } = state;

  if (!artifacts.architectOutput) {
    return '❌ 스킬 생성 실패 - Architect 단계에서 오류 발생';
  }

  const output = artifacts.architectOutput;

  return `## 🎉 스킬 생성 완료!

**스킬명:** \`${output.skillName}\`
**목적:** ${output.purpose}

### 📋 요약
- **워크플로우 단계:** ${output.workflow.length}개
- **생성된 파일:** ${output.fileStructure.length}개
- **복잡도:** ${output.estimatedComplexity}

### 🚀 다음 단계
1. 생성된 파일을 확인하세요
2. 필요시 코드를 수정하세요
3. 테스트를 실행하세요

---
> 💡 **Tip:** \`/forge ${request.name}\`으로 다시 생성할 수 있습니다`;
}

// ===== Error Message =====

export function formatErrorMessage(error: string): string {
  return `## ❌ 오류 발생

\`\`\`
${error}
\`\`\`

다시 시도해 주세요. 문제가 지속되면 관리자에게 문의하세요.`;
}

// ===== Countdown Timer Display =====

export function getCountdownEmoji(seconds: number): string {
  if (seconds > 3) return '🟢';
  if (seconds > 1) return '🟡';
  return '🔴';
}

export function formatCountdownLine(seconds: number): string {
  const emoji = getCountdownEmoji(seconds);
  const bar = '▓'.repeat(seconds) + '░'.repeat(5 - seconds);
  return `${emoji} [${bar}] ${seconds}초`;
}

// ===== Rich Embed Formatters =====

export function formatArchitectEmbed(output: ArchitectOutput, seconds?: number): DiscordEmbed {
  const complexity = {
    simple: '🟢 Simple',
    medium: '🟡 Medium',
    complex: '🔴 Complex',
  }[output.estimatedComplexity];

  const fields = [
    {
      name: '📋 워크플로우',
      value: output.workflow.map((w) => `\`${w.step}.\` ${w.action}`).join('\n') || 'N/A',
      inline: true,
    },
    {
      name: '📁 파일 구조',
      value: output.fileStructure.map((f) => `\`${f.path}\``).join('\n') || 'N/A',
      inline: true,
    },
    {
      name: '🔧 도구',
      value: output.toolsRequired.map((t) => `\`${t}\``).join(', ') || 'N/A',
      inline: false,
    },
  ];

  return {
    title: `🏗️ Architect: ${output.skillName}`,
    description: `**목적:** ${output.purpose}\n**복잡도:** ${complexity}`,
    color: COLORS.architect,
    fields,
    footer:
      seconds !== undefined ? { text: `⏳ ${seconds}초 후 자동 승인 → Developer` } : undefined,
  };
}

export function formatDeveloperEmbed(output: DeveloperOutput, seconds?: number): DiscordEmbed {
  const fileList = output.files.map((f) => `📄 \`${f.path}\` (${f.language})`).join('\n');

  return {
    title: '💻 Developer 작업 완료',
    description: `**생성된 파일 ${output.files.length}개**\n\n${fileList}`,
    color: COLORS.developer,
    fields: [
      {
        name: '📦 설치',
        value: output.installInstructions.map((i) => `\`${i}\``).join('\n') || '없음',
        inline: true,
      },
      {
        name: '🧪 테스트',
        value: output.testCommands.map((c) => `\`${c}\``).join('\n') || '없음',
        inline: true,
      },
    ],
    footer: seconds !== undefined ? { text: `⏳ ${seconds}초 후 자동 승인 → QA` } : undefined,
  };
}

export function formatQAEmbed(output: QAOutput, seconds?: number): DiscordEmbed {
  const status = output.passed ? '✅ PASSED' : '❌ FAILED';
  const recommendation = {
    approve: '🟢 승인',
    revise: '🟡 수정 필요',
    reject: '🔴 거부',
  }[output.recommendation];

  const checklistStr =
    output.checklist.map((c) => `${c.passed ? '✅' : '❌'} ${c.item}`).join('\n') || '없음';

  const issuesStr = output.issues.length
    ? output.issues
        .map((i) => {
          const icon = { critical: '🔴', warning: '🟡', suggestion: '🔵' }[i.severity];
          return `${icon} ${i.description}`;
        })
        .join('\n')
    : '없음';

  return {
    title: `🔍 QA 검증 ${status}`,
    description: `**권장:** ${recommendation}`,
    color: output.passed ? COLORS.success : COLORS.danger,
    fields: [
      {
        name: '✅ 체크리스트',
        value: checklistStr,
        inline: false,
      },
      {
        name: '⚠️ 이슈',
        value: issuesStr,
        inline: false,
      },
    ],
    footer: seconds !== undefined ? { text: `⏳ ${seconds}초 후 자동 완료` } : undefined,
  };
}

// ===== Live Countdown Message =====

export function formatLiveCountdownMessage(
  phase: SessionPhase,
  secondsRemaining: number,
  artifacts: SessionState['artifacts']
): DiscordMessage {
  const embeds: DiscordEmbed[] = [];

  switch (phase) {
    case 'architect_review':
      if (artifacts.architectOutput) {
        embeds.push(formatArchitectEmbed(artifacts.architectOutput, secondsRemaining));
      }
      break;
    case 'developer_review':
      if (artifacts.developerOutput) {
        embeds.push(formatDeveloperEmbed(artifacts.developerOutput, secondsRemaining));
      }
      break;
    case 'qa_review':
      if (artifacts.qaOutput) {
        embeds.push(formatQAEmbed(artifacts.qaOutput, secondsRemaining));
      }
      break;
  }

  // Add animated countdown bar
  const bar = formatAnimatedCountdown(secondsRemaining, 5);

  return {
    content: bar,
    embeds,
    components: [getReviewButtons(secondsRemaining)],
  };
}

function formatAnimatedCountdown(current: number, total: number): string {
  const filled = '█'.repeat(current);
  const empty = '░'.repeat(total - current);
  const emoji = current > 2 ? '🟢' : current > 0 ? '🟡' : '🔴';
  return `${emoji} **${current}s** [${filled}${empty}]`;
}

// ===== Session Summary with Embeds =====

export function formatSessionSummaryEmbed(state: SessionState): DiscordEmbed {
  const { artifacts, request } = state;
  const isComplete = state.phase === 'completed';

  const fields = [];

  if (artifacts.architectOutput) {
    fields.push({
      name: '🏗️ Architect',
      value: `${artifacts.architectOutput.workflow.length}단계 설계`,
      inline: true,
    });
  }

  if (artifacts.developerOutput) {
    fields.push({
      name: '💻 Developer',
      value: `${artifacts.developerOutput.files.length}개 파일`,
      inline: true,
    });
  }

  if (artifacts.qaOutput) {
    const qa = artifacts.qaOutput;
    fields.push({
      name: '🔍 QA',
      value: `${qa.checklist.filter((c) => c.passed).length}/${qa.checklist.length} 통과`,
      inline: true,
    });
  }

  return {
    title: isComplete ? `🎉 ${request.name} 생성 완료!` : `⏳ ${request.name} 진행 중...`,
    description: request.description,
    color: isComplete ? COLORS.success : COLORS.primary,
    fields,
    timestamp: new Date().toISOString(),
    footer: {
      text: 'Skill Forge 🔥',
    },
  };
}

// ===== Test =====

async function runTest() {
  console.log('🖥️ Discord UI Test\n');

  // Mock architect output
  const mockArchitectOutput: ArchitectOutput = {
    skillName: 'test-skill',
    purpose: '테스트 스킬입니다',
    triggers: ['/test'],
    workflow: [
      { step: 1, action: 'parse', description: '입력 파싱' },
      { step: 2, action: 'execute', description: '실행' },
    ],
    fileStructure: [{ path: 'skills/test/index.ts', purpose: '메인' }],
    toolsRequired: ['Read', 'Write'],
    estimatedComplexity: 'simple',
  };

  // Test old format
  const message = formatCountdownMessage('architect_review', 5, {
    architectOutput: mockArchitectOutput,
  });

  console.log('=== Architect Review Message ===\n');
  console.log(message.content);
  console.log('\n=== Buttons ===');
  console.log(JSON.stringify(message.components, null, 2));

  console.log('\n=== Countdown Line ===');
  for (let i = 5; i >= 0; i--) {
    console.log(formatCountdownLine(i));
  }

  // Test new embed format
  console.log('\n=== Embed Format ===');
  const embed = formatArchitectEmbed(mockArchitectOutput, 5);
  console.log(JSON.stringify(embed, null, 2));

  // Test live countdown
  console.log('\n=== Live Countdown Message ===');
  const liveMsg = formatLiveCountdownMessage('architect_review', 3, {
    architectOutput: mockArchitectOutput,
  });
  console.log('Content:', liveMsg.content);
  console.log('Embeds:', liveMsg.embeds?.length || 0);
}

// ESM entry point
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runTest();
}
