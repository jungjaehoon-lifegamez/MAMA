/**
 * Phase 8: Capability Demonstration
 *
 * Interactive demos showcasing MAMA's capabilities through live examples.
 * Demonstrates file operations, code analysis, and interactive workflows.
 * Saves demo execution logs for future reference.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { expandPath } from '../cli/config/config-manager.js';
import type { ToolDefinition } from '../agent/types.js';

/**
 * Demo type categories
 */
export type DemoType = 'file_ops' | 'code_analysis' | 'interactive' | 'all';

/**
 * Demo execution result
 */
export interface DemoResult {
  type: DemoType;
  name: string;
  description: string;
  steps: Array<{
    action: string;
    result: string;
    success: boolean;
  }>;
  timestamp: string;
}

/**
 * Input schema for demonstrate_capability tool
 */
export interface DemoToolInput {
  demo_type?: DemoType;
  interactive?: boolean;
  save_log?: boolean;
}

/**
 * Demo definitions for different capability types
 */
const DEMOS = {
  file_ops: {
    name: 'File Operations Demo',
    description: 'Demonstrates reading, writing, and managing files',
    steps: [
      {
        action: 'Create demo directory',
        execute: async () => {
          const demoDir = expandPath('~/.mama/demos');
          if (!existsSync(demoDir)) {
            await mkdir(demoDir, { recursive: true });
          }
          return `Created directory: ${demoDir}`;
        },
      },
      {
        action: 'Write sample file',
        execute: async () => {
          const filePath = expandPath('~/.mama/demos/sample.txt');
          const content = `# Demo File\n\nThis is a sample file created during MAMA capability demonstration.\nTimestamp: ${new Date().toISOString()}\n`;
          await writeFile(filePath, content, 'utf-8');
          return `Written ${content.length} bytes to ${filePath}`;
        },
      },
      {
        action: 'Read sample file',
        execute: async () => {
          const filePath = expandPath('~/.mama/demos/sample.txt');
          const content = await readFile(filePath, 'utf-8');
          return `Read ${content.length} bytes:\n${content.substring(0, 100)}...`;
        },
      },
      {
        action: 'Create JSON configuration',
        execute: async () => {
          const configPath = expandPath('~/.mama/demos/config.json');
          const config = {
            version: '1.0.0',
            demo: true,
            timestamp: new Date().toISOString(),
            features: ['file_ops', 'code_analysis', 'interactive'],
          };
          await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
          return `Created JSON config at ${configPath}`;
        },
      },
    ],
  },

  code_analysis: {
    name: 'Code Analysis Demo',
    description: 'Demonstrates code understanding and analysis capabilities',
    steps: [
      {
        action: 'Analyze TypeScript interface',
        execute: async () => {
          const sampleCode = `
interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user' | 'guest';
  metadata?: Record<string, any>;
}`;
          const analysis = {
            type: 'TypeScript Interface',
            properties: 5,
            optionalFields: 1,
            complexTypes: ['union type (role)', 'generic type (Record)'],
          };
          return `Analyzed code:\n${sampleCode}\n\nAnalysis: ${JSON.stringify(analysis, null, 2)}`;
        },
      },
      {
        action: 'Detect code patterns',
        execute: async () => {
          const sampleCode = `
async function fetchUserData(userId: string): Promise<User> {
  const response = await fetch(\`/api/users/\${userId}\`);
  if (!response.ok) throw new Error('Failed to fetch user');
  return response.json();
}`;
          const patterns = [
            'Async/await pattern',
            'Template literal usage',
            'Error handling with throw',
            'Type assertion with Promise<T>',
          ];
          return `Code sample:\n${sampleCode}\n\nDetected patterns:\n${patterns.map((p) => `- ${p}`).join('\n')}`;
        },
      },
      {
        action: 'Suggest improvements',
        execute: async () => {
          const suggestions = [
            '✅ Use proper error types instead of generic Error',
            '✅ Add retry logic for network failures',
            '✅ Implement response validation',
            '✅ Add timeout handling',
            '✅ Consider caching for repeated requests',
          ];
          return `Code improvement suggestions:\n${suggestions.join('\n')}`;
        },
      },
    ],
  },

  interactive: {
    name: 'Interactive Workflow Demo',
    description: 'Demonstrates multi-step interactive workflows',
    steps: [
      {
        action: 'Initialize workflow context',
        execute: async () => {
          const context = {
            workflowId: `workflow_${Date.now()}`,
            startTime: new Date().toISOString(),
            steps: [],
            state: 'initialized',
          };
          return `Workflow context: ${JSON.stringify(context, null, 2)}`;
        },
      },
      {
        action: 'Simulate decision point',
        execute: async () => {
          const decision = {
            question: 'Which analysis type should we run?',
            options: ['quick', 'deep', 'comprehensive'],
            selected: 'deep',
            reasoning: 'Deep analysis provides better insights for complex codebases',
          };
          return `Decision made: ${JSON.stringify(decision, null, 2)}`;
        },
      },
      {
        action: 'Execute workflow step',
        execute: async () => {
          const stepResult = {
            stepId: 'analysis_1',
            action: 'Deep code analysis',
            duration: '2.3s',
            findings: 12,
            status: 'completed',
          };
          return `Step completed: ${JSON.stringify(stepResult, null, 2)}`;
        },
      },
      {
        action: 'Generate workflow summary',
        execute: async () => {
          const summary = `
# Workflow Summary

**Workflow ID**: workflow_${Date.now()}
**Status**: Completed successfully
**Duration**: 2.3 seconds
**Steps Executed**: 3
**Findings**: 12

## Key Results
- Initialized workflow context
- Made informed decision (deep analysis)
- Completed analysis successfully

## Next Steps
- Review findings
- Apply recommended changes
- Verify improvements
`;
          return summary.trim();
        },
      },
    ],
  },
};

/**
 * Execute a specific demo type
 */
async function executeDemo(type: Exclude<DemoType, 'all'>): Promise<DemoResult> {
  const demo = DEMOS[type];
  const result: DemoResult = {
    type,
    name: demo.name,
    description: demo.description,
    steps: [],
    timestamp: new Date().toISOString(),
  };

  for (const step of demo.steps) {
    try {
      const output = await step.execute();
      result.steps.push({
        action: step.action,
        result: output,
        success: true,
      });
    } catch (error) {
      result.steps.push({
        action: step.action,
        result: error instanceof Error ? error.message : 'Unknown error',
        success: false,
      });
    }
  }

  return result;
}

/**
 * Save demo log to file
 */
async function saveDemoLog(results: DemoResult[]): Promise<string> {
  const logPath = expandPath('~/.mama/demo-log.md');
  let content = `# MAMA Capability Demonstration Log\n\n`;
  content += `*Last updated: ${new Date().toISOString()}*\n\n`;
  content += `---\n\n`;

  for (const result of results) {
    content += `## ${result.name}\n\n`;
    content += `**Type**: \`${result.type}\`\n`;
    content += `**Description**: ${result.description}\n`;
    content += `**Timestamp**: ${result.timestamp}\n\n`;

    content += `### Execution Steps\n\n`;
    for (let i = 0; i < result.steps.length; i++) {
      const step = result.steps[i];
      const icon = step.success ? '✅' : '❌';
      content += `#### ${i + 1}. ${step.action} ${icon}\n\n`;
      content += `\`\`\`\n${step.result}\n\`\`\`\n\n`;
    }

    content += `---\n\n`;
  }

  // Append summary
  content += `## Summary\n\n`;
  content += `Total demos executed: ${results.length}\n`;
  const totalSteps = results.reduce((acc, r) => acc + r.steps.length, 0);
  const successfulSteps = results.reduce(
    (acc, r) => acc + r.steps.filter((s) => s.success).length,
    0
  );
  content += `Total steps: ${totalSteps}\n`;
  content += `Successful steps: ${successfulSteps}\n`;
  content += `Success rate: ${((successfulSteps / totalSteps) * 100).toFixed(1)}%\n\n`;

  await writeFile(logPath, content, 'utf-8');
  return logPath;
}

/**
 * Phase 8 Tool: Demonstrate Capability
 */
export const PHASE_8_TOOL: ToolDefinition = {
  name: 'demonstrate_capability',
  description:
    'Interactive capability demonstration tool. Runs live demos of file operations, code analysis, and interactive workflows. Saves execution logs to demo-log.md for future reference.',
  input_schema: {
    type: 'object',
    properties: {
      demo_type: {
        type: 'string',
        enum: ['file_ops', 'code_analysis', 'interactive', 'all'],
        description:
          'Type of demo to run: file_ops (file operations), code_analysis (code understanding), interactive (multi-step workflows), or all (run all demos)',
      },
      interactive: {
        type: 'boolean',
        description:
          'If true, show detailed step-by-step output. If false, show summary only (default: true)',
      },
      save_log: {
        type: 'boolean',
        description: 'If true, save demo results to demo-log.md (default: true)',
      },
    },
    required: [],
  },
};

/**
 * Handler for demonstrate_capability tool
 */
export async function handleDemoTool(input: DemoToolInput): Promise<any> {
  const demoType = input.demo_type || 'all';
  const interactive = input.interactive !== false;
  const saveLog = input.save_log !== false;

  try {
    let results: DemoResult[];

    if (demoType === 'all') {
      // Run all demos
      results = await Promise.all([
        executeDemo('file_ops'),
        executeDemo('code_analysis'),
        executeDemo('interactive'),
      ]);
    } else {
      // Run specific demo
      results = [await executeDemo(demoType)];
    }

    // Save log if requested
    let logPath: string | undefined;
    if (saveLog) {
      logPath = await saveDemoLog(results);
    }

    // Format response
    let message = `# 🎯 Capability Demonstration Complete\n\n`;
    message += `Executed ${results.length} demo(s):\n\n`;

    for (const result of results) {
      const successCount = result.steps.filter((s) => s.success).length;
      const totalSteps = result.steps.length;
      const successRate = ((successCount / totalSteps) * 100).toFixed(0);

      message += `## ${result.name}\n`;
      message += `- Steps: ${successCount}/${totalSteps} successful (${successRate}%)\n`;

      if (interactive) {
        message += `\n### Steps:\n`;
        for (const step of result.steps) {
          const icon = step.success ? '✅' : '❌';
          message += `\n**${icon} ${step.action}**\n`;
          message += `\`\`\`\n${step.result.substring(0, 200)}${step.result.length > 200 ? '...' : ''}\n\`\`\`\n`;
        }
      }
      message += `\n`;
    }

    if (logPath) {
      message += `\n---\n\n📝 **Demo log saved**: ${logPath}\n`;
    }

    return {
      success: true,
      message,
      results,
      log_path: logPath,
      phase_8_complete: true,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during demo execution',
      phase_8_complete: false,
    };
  }
}
