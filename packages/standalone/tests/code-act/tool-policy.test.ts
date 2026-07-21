import { describe, expect, it, vi } from 'vitest';
import { HostBridge } from '../../src/agent/code-act/host-bridge.js';
import { CodeActSandbox } from '../../src/agent/code-act/sandbox.js';
import { TypeDefinitionGenerator } from '../../src/agent/code-act/type-definition-generator.js';
import {
  CodeActToolPolicyValidationError,
  projectCodeActToolPolicy,
} from '../../src/agent/code-act/tool-policy.js';
import type { CodeActToolPolicyFingerprintData } from '../../src/agent/code-act/tool-policy.js';
import type { CodeActToolPolicyInput } from '../../src/agent/code-act/tool-policy.js';
import type { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';

function declaredNames(source: string): string[] {
  return [...source.matchAll(/declare function ([A-Za-z0-9_]+)\(/g)].map((match) => match[1]);
}

describe('Code-Act canonical tool policy', () => {
  it('projects every default owner workflow except the outer code_act entry point', () => {
    const owner = DEFAULT_ROLES.definitions.owner_console;
    const expectedInnerTools = owner.allowedTools.filter((tool) => tool !== 'code_act');
    const registryNames = HostBridge.getToolRegistry().map((tool) => tool.name);
    const policy = projectCodeActToolPolicy({ tier: 2, role: owner });

    expect(registryNames).toEqual(expect.arrayContaining(expectedInnerTools));
    expect(policy.names).toEqual([...expectedInnerTools].sort());
  });

  it('expands role wildcards into sorted, deduplicated registry names', () => {
    const policy = projectCodeActToolPolicy({
      tier: 1,
      role: { allowedTools: ['mama_*', 'Read', 'mama_*', 'Read'] },
    });

    expect(policy.names).toEqual([...policy.names].sort());
    expect(new Set(policy.names).size).toBe(policy.names.length);
    expect(policy.names).toContain('Read');
    expect(policy.names).toContain('mama_search');
    expect(policy.names).toContain('mama_save');
    expect(policy.names).not.toContain('Write');
  });

  it('lets role blocks and runtime disallows override role allows', () => {
    const policy = projectCodeActToolPolicy({
      tier: 1,
      role: {
        allowedTools: ['mama_*', 'Read', 'Write'],
        blockedTools: ['mama_save', 'Write'],
      },
      disallowedTools: ['Read'],
    });

    expect(policy.names).toContain('mama_search');
    expect(policy.names).not.toContain('mama_save');
    expect(policy.names).not.toContain('Read');
    expect(policy.names).not.toContain('Write');
  });

  it('applies the HostBridge tier rules before returning definitions', () => {
    const tierOne = projectCodeActToolPolicy({ tier: 1, role: { allowedTools: ['*'] } });
    const tierTwo = projectCodeActToolPolicy({ tier: 2, role: { allowedTools: ['*'] } });
    const tierThree = projectCodeActToolPolicy({ tier: 3, role: { allowedTools: ['*'] } });

    expect(tierOne.names).toContain('Write');
    expect(tierTwo.names).not.toContain('Write');
    expect(tierTwo.names).toContain('mama_save');
    expect(tierThree.names).not.toContain('mama_save');
    expect(tierThree.names).toContain('mama_search');
  });

  it('allows both model fields to narrow but never widen the role policy', () => {
    const policy = projectCodeActToolPolicy({
      tier: 1,
      role: { allowedTools: ['mama_*', 'Read'] },
      requestedAllowedTools: ['mama_*', 'Write'],
      requestedBlockedTools: ['mama_save'],
    });

    expect(policy.names).toContain('mama_search');
    expect(policy.names).not.toContain('mama_save');
    expect(policy.names).not.toContain('Read');
    expect(policy.names).not.toContain('Write');
  });

  it.each(['requestedAllowedTools', 'requestedBlockedTools'] as const)(
    'rejects unknown nonempty patterns in %s',
    (field) => {
      expect(() =>
        projectCodeActToolPolicy({
          tier: 1,
          role: { allowedTools: ['*'] },
          [field]: ['not_a_gateway_tool'],
        })
      ).toThrow(CodeActToolPolicyValidationError);
    }
  );

  it.each([0, 4, Number.NaN, '2'])('rejects invalid runtime tier %s', (tier) => {
    expect(() =>
      projectCodeActToolPolicy({
        tier: tier as unknown as 1,
        role: { allowedTools: ['*'] },
      })
    ).toThrow(/Invalid Code-Act tier/);
  });

  it('builds a deterministic fingerprint payload with full signatures and normalized inputs', () => {
    const first = projectCodeActToolPolicy({
      tier: 2,
      role: { allowedTools: ['mama_*', 'Read', 'mama_*'], blockedTools: ['mama_update'] },
      disallowedTools: ['mama_load_checkpoint', 'mama_load_checkpoint'],
      requestedAllowedTools: ['Read', 'mama_search'],
      requestedBlockedTools: [],
    });
    const second = projectCodeActToolPolicy({
      tier: 2,
      role: { allowedTools: ['Read', 'mama_*'], blockedTools: ['mama_update'] },
      disallowedTools: ['mama_load_checkpoint'],
      requestedAllowedTools: ['mama_search', 'Read'],
      requestedBlockedTools: [],
    });

    expect(typeof first.fingerprintPayload).toBe('string');
    expect(first.fingerprintPayload).toBe(second.fingerprintPayload);
    const fingerprint = JSON.parse(first.fingerprintPayload) as CodeActToolPolicyFingerprintData;
    expect(fingerprint.inputs).toEqual({
      tier: 2,
      roleAllowedTools: ['Read', 'mama_*'],
      roleBlockedTools: ['mama_update'],
      runtimeDisallowedTools: ['mama_load_checkpoint'],
      requestedAllowedTools: ['Read', 'mama_search'],
      requestedBlockedTools: [],
    });
    const search = fingerprint.tools.find((tool: { name: string }) => tool.name === 'mama_search');
    expect(search?.params).toContainEqual({
      name: 'query',
      type: 'string',
      required: false,
      description: 'Search query',
    });
    expect(search?.returnType).toContain('results:');
  });

  it('renders exactly the projected definitions without independently widening them', () => {
    const policy = projectCodeActToolPolicy({
      tier: 1,
      role: { allowedTools: ['Read', 'mama_search'] },
    });

    expect(declaredNames(TypeDefinitionGenerator.generate(policy)).sort()).toEqual(policy.names);
  });

  it('treats policy names as authoritative when definitions contain extra tools', () => {
    const policy = projectCodeActToolPolicy({
      tier: 1,
      role: { allowedTools: ['Read', 'mama_search'] },
    });

    const narrowed = { ...policy, names: ['mama_search'] };

    expect(declaredNames(TypeDefinitionGenerator.generate(narrowed))).toEqual(['mama_search']);
  });

  it('deep-freezes the projected surface so it cannot diverge from its fingerprint', () => {
    const policy = projectCodeActToolPolicy({
      tier: 1,
      role: { allowedTools: ['mama_search'] },
    });
    const fingerprint = policy.fingerprintPayload;
    const [definition] = policy.definitions;
    const [param] = definition.params;

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.names)).toBe(true);
    expect(Object.isFrozen(policy.definitions)).toBe(true);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.params)).toBe(true);
    expect(Object.isFrozen(param)).toBe(true);
    expect(() => (policy.names as string[]).push('Write')).toThrow(TypeError);
    expect(() => ((definition as { name: string }).name = 'Write')).toThrow(TypeError);
    expect(() => ((param as { type: string }).type = 'unknown')).toThrow(TypeError);
    expect(policy.fingerprintPayload).toBe(fingerprint);
  });

  it('keeps advertised, registered, and invoked names identical for one complete projection', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true });
    const executor = { execute } as unknown as GatewayToolExecutor;
    const policyInput: CodeActToolPolicyInput = {
      tier: 2,
      role: {
        allowedTools: ['mama_search', 'mama_update', 'mama_save', 'Read', 'delegate'],
        blockedTools: ['mama_update'],
      },
      disallowedTools: ['Read'],
      requestedAllowedTools: ['mama_search', 'mama_update', 'mama_save', 'Read', 'delegate'],
      requestedBlockedTools: ['mama_save'],
    };
    const policy = projectCodeActToolPolicy(policyInput);
    const withoutRoleBlock = projectCodeActToolPolicy({
      ...policyInput,
      role: { ...policyInput.role, blockedTools: [] },
    });
    const withoutRuntimeDisallow = projectCodeActToolPolicy({
      ...policyInput,
      disallowedTools: [],
    });
    const withoutTierFilter = projectCodeActToolPolicy({
      ...policyInput,
      tier: 1,
    });
    const withoutRequestedBlock = projectCodeActToolPolicy({
      ...policyInput,
      requestedBlockedTools: [],
    });

    expect(policy.names).not.toContain('mama_update');
    expect(withoutRoleBlock.names).toContain('mama_update');
    expect(policy.names).not.toContain('Read');
    expect(withoutRuntimeDisallow.names).toContain('Read');
    expect(policy.names).not.toContain('delegate');
    expect(withoutTierFilter.names).toContain('delegate');
    expect(policy.names).not.toContain('mama_save');
    expect(withoutRequestedBlock.names).toContain('mama_save');

    const sandbox = new CodeActSandbox();
    new HostBridge(executor).injectInto(sandbox, policy.names);

    const advertised = declaredNames(TypeDefinitionGenerator.generate(policy)).sort();
    const registered = sandbox.getRegisteredFunctions().sort();
    const result = await sandbox.execute('mama_search({ query: "parity" })');
    const invoked = execute.mock.calls.map(([name]) => String(name)).sort();

    expect(result.success).toBe(true);
    expect(advertised.length).toBeGreaterThan(0);
    expect(registered).toEqual(advertised);
    expect(invoked).toEqual(advertised);
  });
});
