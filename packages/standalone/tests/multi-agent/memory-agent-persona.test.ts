import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureMemoryPersona,
  MEMORY_AGENT_PERSONA,
} from '../../src/multi-agent/memory-agent-persona.js';

const LEGACY_PERSONA = `You are MAMA's memory agent — an always-on observer that watches conversations and extracts knowledge worth remembering.

## Your Role
- Observe every conversation turn between users and the main agent
- Extract decisions, preferences, lessons, and constraints
- Return structured JSON for storage — never respond to users directly

## Output Format
Return ONLY a JSON object:
{"facts":[]}`;

describe('memory-agent persona management', () => {
  it('should create the latest persona when missing', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'mama-memory-persona-'));

    const personaPath = ensureMemoryPersona(homeDir);

    expect(personaPath).toBe(join(homeDir, 'personas', 'memory.md'));
    expect(readFileSync(personaPath, 'utf-8')).toBe(MEMORY_AGENT_PERSONA);
  });

  it('should upgrade legacy managed JSON extractor personas', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'mama-memory-persona-'));
    const personaDir = join(homeDir, 'personas');
    const personaPath = join(personaDir, 'memory.md');
    mkdirSync(personaDir, { recursive: true });
    writeFileSync(personaPath, LEGACY_PERSONA, 'utf-8');

    ensureMemoryPersona(homeDir);

    expect(readFileSync(personaPath, 'utf-8')).toBe(MEMORY_AGENT_PERSONA);
  });

  it('should preserve custom personas that are not legacy managed files', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'mama-memory-persona-'));
    const personaDir = join(homeDir, 'personas');
    const personaPath = join(personaDir, 'memory.md');
    mkdirSync(personaDir, { recursive: true });
    writeFileSync(personaPath, '# custom memory persona\nDo not overwrite me.\n', 'utf-8');

    ensureMemoryPersona(homeDir);

    expect(readFileSync(personaPath, 'utf-8')).toBe(
      '# custom memory persona\nDo not overwrite me.\n'
    );
  });
});
