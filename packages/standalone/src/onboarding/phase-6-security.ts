import { writeFile } from 'node:fs/promises';
import { expandPath } from '../cli/config/config-manager.js';
import { completePhase, recordFileCreated } from './onboarding-state.js';

/**
 * Phase 6: Security Warning
 *
 * MANDATORY gate before Phase 7. Explains security risks and requires
 * explicit acknowledgment before granting full system access.
 *
 * Covers 4 critical risk factors:
 * 1. File access - Read/write any file on the system
 * 2. Command execution - Run arbitrary shell commands
 * 3. Network access - Make HTTP requests, access APIs
 * 4. Integration access - Control connected platforms (Slack, Discord, etc.)
 */

export interface SecurityToolInput {
  language?: 'en' | 'ko';
  acknowledge?: boolean;
}

export interface SecurityTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
  handler: (input: SecurityToolInput) => Promise<any>;
}

const SECURITY_RISKS = {
  en: {
    file_access: {
      title: '🗂️  File Access Risk',
      description:
        'MAMA can read and write ANY file on your system that your user account can access.',
      examples: [
        '✅ Safe: Read project files, write logs',
        '⚠️  Risky: Access ~/.ssh/id_rsa, ~/.aws/credentials',
        '❌ Dangerous: Modify system files, delete important data',
      ],
      mitigation: [
        'Run MAMA in a dedicated user account with limited permissions',
        'Use file system permissions to restrict sensitive directories',
        'Regularly audit file access logs',
      ],
    },
    command_execution: {
      title: '⚡ Command Execution Risk',
      description: 'MAMA can execute arbitrary shell commands with your user privileges.',
      examples: [
        '✅ Safe: npm install, git commit, docker build',
        '⚠️  Risky: curl | bash, rm -rf with wildcards',
        '❌ Dangerous: sudo commands, system service manipulation',
      ],
      mitigation: [
        'Never run MAMA with sudo or root privileges',
        'Use Docker containers or VMs for isolated execution',
        'Review command history regularly',
      ],
    },
    network_access: {
      title: '🌐 Network Access Risk',
      description: 'MAMA can make HTTP requests and connect to external services.',
      examples: [
        '✅ Safe: Fetch documentation, check package versions',
        '⚠️  Risky: Upload files to unknown endpoints',
        '❌ Dangerous: Exfiltrate sensitive data, DDoS attacks',
      ],
      mitigation: [
        'Use firewall rules to restrict outbound connections',
        'Monitor network traffic for suspicious activity',
        'Limit API keys to read-only access when possible',
      ],
    },
    integration_access: {
      title: '🔌 Integration Access Risk',
      description:
        'MAMA can send messages and perform actions on connected platforms (Slack, Discord, etc.)',
      examples: [
        '✅ Safe: Send notifications, respond to DMs',
        '⚠️  Risky: Post in public channels without review',
        '❌ Dangerous: Spam, impersonate you, leak private data',
      ],
      mitigation: [
        'Use separate bot accounts, not personal accounts',
        'Limit bot permissions to necessary scopes only',
        'Enable approval workflows for public actions',
      ],
    },
  },
  ko: {
    file_access: {
      title: '🗂️  파일 접근 위험',
      description: 'MAMA는 사용자 계정이 접근할 수 있는 모든 파일을 읽고 쓸 수 있습니다.',
      examples: [
        '✅ 안전: 프로젝트 파일 읽기, 로그 작성',
        '⚠️  위험: ~/.ssh/id_rsa, ~/.aws/credentials 접근',
        '❌ 매우 위험: 시스템 파일 수정, 중요 데이터 삭제',
      ],
      mitigation: [
        '제한된 권한을 가진 전용 사용자 계정에서 MAMA 실행',
        '파일 시스템 권한으로 민감한 디렉토리 제한',
        '파일 접근 로그 정기적 감사',
      ],
    },
    command_execution: {
      title: '⚡ 명령 실행 위험',
      description: 'MAMA는 사용자 권한으로 임의의 셸 명령을 실행할 수 있습니다.',
      examples: [
        '✅ 안전: npm install, git commit, docker build',
        '⚠️  위험: curl | bash, 와일드카드를 사용한 rm -rf',
        '❌ 매우 위험: sudo 명령, 시스템 서비스 조작',
      ],
      mitigation: [
        'sudo나 root 권한으로 MAMA를 절대 실행하지 말 것',
        '격리된 실행을 위해 Docker 컨테이너나 VM 사용',
        '명령 히스토리 정기적 검토',
      ],
    },
    network_access: {
      title: '🌐 네트워크 접근 위험',
      description: 'MAMA는 HTTP 요청을 만들고 외부 서비스에 연결할 수 있습니다.',
      examples: [
        '✅ 안전: 문서 가져오기, 패키지 버전 확인',
        '⚠️  위험: 알 수 없는 엔드포인트로 파일 업로드',
        '❌ 매우 위험: 민감한 데이터 유출, DDoS 공격',
      ],
      mitigation: [
        '방화벽 규칙으로 아웃바운드 연결 제한',
        '의심스러운 활동에 대한 네트워크 트래픽 모니터링',
        '가능한 경우 읽기 전용 API 키 사용',
      ],
    },
    integration_access: {
      title: '🔌 통합 접근 위험',
      description:
        'MAMA는 연결된 플랫폼(Slack, Discord 등)에서 메시지를 보내고 작업을 수행할 수 있습니다.',
      examples: [
        '✅ 안전: 알림 전송, DM에 응답',
        '⚠️  위험: 검토 없이 공개 채널에 게시',
        '❌ 매우 위험: 스팸, 사용자 사칭, 개인 데이터 유출',
      ],
      mitigation: [
        '개인 계정이 아닌 별도의 봇 계정 사용',
        '필요한 범위로만 봇 권한 제한',
        '공개 작업에 대한 승인 워크플로우 활성화',
      ],
    },
  },
};

const SANDBOX_RECOMMENDATIONS = {
  en: {
    title: '🛡️  Recommended: Sandbox Setup',
    intro: 'For maximum security, run MAMA in an isolated environment with limited privileges.',
    methods: [
      {
        name: 'Docker Container (Easiest)',
        steps: [
          'Create a Dockerfile with minimal base image',
          'Mount only necessary directories as read-only',
          'Use --network=none flag to disable network access',
          'Run container with --user flag (non-root)',
        ],
      },
      {
        name: 'Virtual Machine',
        steps: [
          'Use lightweight VM (e.g., Alpine Linux)',
          'Snapshot before running MAMA',
          'Limit VM network access via host firewall',
          'Use separate SSH keys for VM access',
        ],
      },
      {
        name: 'Dedicated User Account',
        steps: [
          'Create new user: useradd -m -s /bin/bash mama-user',
          'Set strict umask: echo "umask 077" >> ~/.bashrc',
          'Restrict sudo access completely',
          'Use chroot jail for additional isolation',
        ],
      },
    ],
  },
  ko: {
    title: '🛡️  권장: 샌드박스 설정',
    intro: '최대 보안을 위해 제한된 권한을 가진 격리된 환경에서 MAMA를 실행하세요.',
    methods: [
      {
        name: 'Docker 컨테이너 (가장 쉬움)',
        steps: [
          '최소한의 베이스 이미지로 Dockerfile 생성',
          '필요한 디렉토리만 읽기 전용으로 마운트',
          '네트워크 접근 비활성화를 위해 --network=none 플래그 사용',
          '비루트 사용자로 컨테이너 실행 (--user 플래그)',
        ],
      },
      {
        name: '가상 머신',
        steps: [
          '경량 VM 사용 (예: Alpine Linux)',
          'MAMA 실행 전 스냅샷 생성',
          '호스트 방화벽을 통해 VM 네트워크 접근 제한',
          'VM 접근용 별도의 SSH 키 사용',
        ],
      },
      {
        name: '전용 사용자 계정',
        steps: [
          '새 사용자 생성: useradd -m -s /bin/bash mama-user',
          '엄격한 umask 설정: echo "umask 077" >> ~/.bashrc',
          'sudo 접근 완전 제한',
          '추가 격리를 위해 chroot jail 사용',
        ],
      },
    ],
  },
};

const SAFE_USAGE_PRACTICES = {
  en: [
    '📋 Review actions before execution - Use dry-run modes when available',
    '🔍 Audit logs regularly - Check file access and command history',
    '🔐 Use read-only API keys - Limit damage from potential leaks',
    '💾 Backup before major changes - Always have a rollback plan',
    '🚫 Never share credentials - Keep tokens and passwords private',
    '👀 Monitor resource usage - Detect unusual CPU/network activity',
    '📦 Principle of least privilege - Grant only necessary permissions',
    '🔄 Rotate secrets regularly - Change API keys and tokens periodically',
  ],
  ko: [
    '📋 실행 전 작업 검토 - 가능한 경우 dry-run 모드 사용',
    '🔍 로그 정기적 감사 - 파일 접근 및 명령 히스토리 확인',
    '🔐 읽기 전용 API 키 사용 - 잠재적 유출로 인한 피해 제한',
    '💾 주요 변경 전 백업 - 항상 롤백 계획 준비',
    '🚫 자격 증명 공유 금지 - 토큰과 비밀번호 비공개 유지',
    '👀 리소스 사용량 모니터링 - 비정상적인 CPU/네트워크 활동 감지',
    '📦 최소 권한 원칙 - 필요한 권한만 부여',
    '🔄 비밀 정보 정기 교체 - API 키와 토큰 주기적으로 변경',
  ],
};

function formatSecurityWarning(language: 'en' | 'ko'): string {
  const risks = SECURITY_RISKS[language];
  const sandbox = SANDBOX_RECOMMENDATIONS[language];
  const practices = SAFE_USAGE_PRACTICES[language];

  if (language === 'ko') {
    return `# ⚠️  보안 경고 - 진행하기 전에 읽어주세요

**중요: 이것은 단순한 경고가 아닙니다. MAMA는 시스템에 대한 강력한 접근 권한을 가집니다.**

다음 단계로 진행하면 MAMA에게 다음 권한을 부여하게 됩니다:

## 🔴 4가지 주요 위험 요소

### ${risks.file_access.title}

${risks.file_access.description}

**예시:**
${risks.file_access.examples.map((ex) => `- ${ex}`).join('\n')}

**완화 방법:**
${risks.file_access.mitigation.map((m) => `- ${m}`).join('\n')}

---

### ${risks.command_execution.title}

${risks.command_execution.description}

**예시:**
${risks.command_execution.examples.map((ex) => `- ${ex}`).join('\n')}

**완화 방법:**
${risks.command_execution.mitigation.map((m) => `- ${m}`).join('\n')}

---

### ${risks.network_access.title}

${risks.network_access.description}

**예시:**
${risks.network_access.examples.map((ex) => `- ${ex}`).join('\n')}

**완화 방법:**
${risks.network_access.mitigation.map((m) => `- ${m}`).join('\n')}

---

### ${risks.integration_access.title}

${risks.integration_access.description}

**예시:**
${risks.integration_access.examples.map((ex) => `- ${ex}`).join('\n')}

**완화 방법:**
${risks.integration_access.mitigation.map((m) => `- ${m}`).join('\n')}

---

## ${sandbox.title}

${sandbox.intro}

${sandbox.methods
  .map(
    (method) => `
### ${method.name}

${method.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}
`
  )
  .join('\n')}

---

## ✅ 안전한 사용 관행

${practices.map((practice) => `${practice}`).join('\n')}

---

## 📝 계속 진행하기 전에

다음 사항을 이해하고 동의해야 합니다:

1. ✅ MAMA가 시스템에 대한 광범위한 접근 권한을 갖는다는 것을 이해했습니다
2. ✅ 위의 4가지 위험 요소와 완화 방법을 읽었습니다
3. ✅ 가능한 경우 샌드박스 환경을 사용할 것을 권장합니다
4. ✅ 안전한 사용 관행을 따를 것입니다
5. ✅ MAMA의 작업을 정기적으로 모니터링하고 감사할 것입니다

**이 경고를 이해하고 위험을 감수할 준비가 되었다면, 도구를 사용하여 확인하세요.**

---

*이 문서는 ~/.mama/security-acknowledgment.md에 저장되었습니다.*
*언제든지 다시 참조할 수 있습니다.*
`;
  } else {
    return `# ⚠️  Security Warning - Read Before Proceeding

**CRITICAL: This is not a routine warning. MAMA has powerful access to your system.**

By proceeding to the next phase, you are granting MAMA the following capabilities:

## 🔴 4 Critical Risk Factors

### ${risks.file_access.title}

${risks.file_access.description}

**Examples:**
${risks.file_access.examples.map((ex) => `- ${ex}`).join('\n')}

**Mitigation:**
${risks.file_access.mitigation.map((m) => `- ${m}`).join('\n')}

---

### ${risks.command_execution.title}

${risks.command_execution.description}

**Examples:**
${risks.command_execution.examples.map((ex) => `- ${ex}`).join('\n')}

**Mitigation:**
${risks.command_execution.mitigation.map((m) => `- ${m}`).join('\n')}

---

### ${risks.network_access.title}

${risks.network_access.description}

**Examples:**
${risks.network_access.examples.map((ex) => `- ${ex}`).join('\n')}

**Mitigation:**
${risks.network_access.mitigation.map((m) => `- ${m}`).join('\n')}

---

### ${risks.integration_access.title}

${risks.integration_access.description}

**Examples:**
${risks.integration_access.examples.map((ex) => `- ${ex}`).join('\n')}

**Mitigation:**
${risks.integration_access.mitigation.map((m) => `- ${m}`).join('\n')}

---

## ${sandbox.title}

${sandbox.intro}

${sandbox.methods
  .map(
    (method) => `
### ${method.name}

${method.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}
`
  )
  .join('\n')}

---

## ✅ Safe Usage Practices

${practices.map((practice) => `${practice}`).join('\n')}

---

## 📝 Before You Continue

You must understand and acknowledge the following:

1. ✅ I understand MAMA has extensive access to my system
2. ✅ I have read the 4 risk factors and mitigation strategies
3. ✅ I will use a sandboxed environment when possible
4. ✅ I will follow safe usage practices
5. ✅ I will regularly monitor and audit MAMA's actions

**If you understand this warning and are ready to accept the risks, use the tool to acknowledge.**

---

*This document has been saved to ~/.mama/security-acknowledgment.md*
*You can refer to it at any time.*
`;
  }
}

/**
 * Phase 6 Tool: Present Security Warning
 *
 * MANDATORY gate before Phase 7. Requires explicit acknowledgment.
 */
export const PHASE_6_TOOL: SecurityTool = {
  name: 'present_security_warning',
  description:
    'Present comprehensive security warning and save acknowledgment. MANDATORY gate before Phase 7. Explains 4 risk factors (file access, command execution, network access, integration access), recommends sandbox setup, and requires explicit user acknowledgment.',
  input_schema: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        enum: ['en', 'ko'],
        description: 'Language for security warning (default: en)',
      },
      acknowledge: {
        type: 'boolean',
        description:
          'User acknowledgment that they understand the risks (default: false). Must be true to proceed.',
      },
    },
    required: [],
  },
  handler: async (input: SecurityToolInput) => {
    const language = input.language || 'en';
    const acknowledge = input.acknowledge || false;

    const warningMessage = formatSecurityWarning(language);

    const filePath = expandPath('~/.mama/security-acknowledgment.md');
    await writeFile(filePath, warningMessage, 'utf-8');

    if (!acknowledge) {
      return {
        success: false,
        warning_presented: true,
        file_saved: filePath,
        message:
          language === 'ko'
            ? '⚠️  보안 경고가 표시되었습니다. 계속하려면 acknowledge: true로 이 도구를 다시 호출하세요.'
            : '⚠️  Security warning presented. To continue, call this tool again with acknowledge: true.',
        next_steps:
          language === 'ko'
            ? '1. 위의 보안 경고를 주의 깊게 읽으세요\n2. 모든 위험 요소와 완화 방법을 이해하세요\n3. 준비가 되면 acknowledge: true로 확인하세요'
            : '1. Read the security warning above carefully\n2. Understand all risk factors and mitigations\n3. When ready, acknowledge with acknowledge: true',
      };
    }

    // Update onboarding state
    completePhase(6);
    recordFileCreated('security-acknowledgment.md');

    return {
      success: true,
      acknowledged: true,
      file_saved: filePath,
      message:
        language === 'ko'
          ? '✅ 보안 경고 확인 완료. Phase 7로 진행할 수 있습니다.'
          : '✅ Security warning acknowledged. You may proceed to Phase 7.',
      risks_understood: [
        'file_access',
        'command_execution',
        'network_access',
        'integration_access',
      ],
      sandbox_recommended: true,
      phase_7_unlocked: true,
    };
  },
};
