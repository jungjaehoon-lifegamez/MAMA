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
    '📋 Review actions before execution - Use dry-run modes when available',
    '🔍 Audit logs regularly - Check file access and command history',
    '🔐 Use read-only API keys - Limit damage from potential leaks',
    '💾 Backup before major changes - Always have a rollback plan',
    '🚫 Never share credentials - Keep tokens and passwords private',
    '👀 Monitor resource usage - Detect unusual CPU/network activity',
    '📦 Principle of least privilege - Grant only necessary permissions',
    '🔄 Rotate secrets regularly - Change API keys and tokens periodically',
  ],
};

function formatSecurityWarning(language: 'en' | 'ko'): string {
  const risks = SECURITY_RISKS[language];
  const sandbox = SANDBOX_RECOMMENDATIONS[language];
  const practices = SAFE_USAGE_PRACTICES[language];

  if (language === 'ko') {
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
            ? '⚠️  Security warning presented. To continue, call this tool again with acknowledge: true.'
            : '⚠️  Security warning presented. To continue, call this tool again with acknowledge: true.',
        next_steps:
          language === 'ko'
            ? '1. Read the security warning above carefully\n2. Understand all risk factors and mitigations\n3. When ready, acknowledge with acknowledge: true'
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
          ? '✅ Security warning acknowledged. You may proceed to Phase 7.'
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
