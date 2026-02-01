/**
 * Onboarding State Persistence
 *
 * Saves and loads onboarding progress so users can resume
 * from where they left off if the session is interrupted.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Onboarding state interface
 */
export interface OnboardingState {
  /** Current phase number (1-9) */
  currentPhase: number;
  /** Completed phase numbers */
  completedPhases: number[];
  /** Discoveries made during onboarding */
  discoveries: {
    userName?: string;
    agentName?: string;
    agentEmoji?: string;
    personalityType?: string;
    language?: string;
    timezone?: string;
  };
  /** Files created during onboarding */
  filesCreated: string[];
  /** Last updated timestamp */
  lastUpdated: number;
  /** Session ID if available */
  sessionId?: string;
}

/**
 * Default initial state
 */
const DEFAULT_STATE: OnboardingState = {
  currentPhase: 1,
  completedPhases: [],
  discoveries: {},
  filesCreated: [],
  lastUpdated: Date.now(),
};

/**
 * Get the path to the onboarding state file
 */
function getStatePath(): string {
  return join(homedir(), '.mama', 'onboarding-state.json');
}

/**
 * Ensure the .mama directory exists
 */
function ensureMamaDir(): void {
  const mamaDir = join(homedir(), '.mama');
  if (!existsSync(mamaDir)) {
    mkdirSync(mamaDir, { recursive: true });
  }
}

/**
 * Load onboarding state from disk
 * @returns Onboarding state or null if not found
 */
export function loadOnboardingState(): OnboardingState | null {
  const statePath = getStatePath();

  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const data = readFileSync(statePath, 'utf-8');
    const state = JSON.parse(data) as OnboardingState;

    // Validate state structure
    if (typeof state.currentPhase !== 'number' || !Array.isArray(state.completedPhases)) {
      console.warn('[OnboardingState] Invalid state structure, returning null');
      return null;
    }

    return state;
  } catch (error) {
    console.error('[OnboardingState] Failed to load state:', error);
    return null;
  }
}

/**
 * Save onboarding state to disk
 * @param state - State to save
 */
export function saveOnboardingState(state: Partial<OnboardingState>): void {
  ensureMamaDir();
  const statePath = getStatePath();

  // Merge with existing state
  const existingState = loadOnboardingState() || DEFAULT_STATE;
  const newState: OnboardingState = {
    ...existingState,
    ...state,
    discoveries: {
      ...existingState.discoveries,
      ...(state.discoveries || {}),
    },
    filesCreated: [
      ...new Set([...(existingState.filesCreated || []), ...(state.filesCreated || [])]),
    ],
    lastUpdated: Date.now(),
  };

  try {
    writeFileSync(statePath, JSON.stringify(newState, null, 2), 'utf-8');
    console.log(`[OnboardingState] Saved state: Phase ${newState.currentPhase}`);
  } catch (error) {
    console.error('[OnboardingState] Failed to save state:', error);
  }
}

/**
 * Mark a phase as completed
 * @param phase - Phase number to mark complete
 */
export function completePhase(phase: number): void {
  const state = loadOnboardingState() || DEFAULT_STATE;

  if (!state.completedPhases.includes(phase)) {
    state.completedPhases.push(phase);
    state.completedPhases.sort((a, b) => a - b);
  }

  // Move to next phase
  state.currentPhase = Math.max(...state.completedPhases) + 1;

  saveOnboardingState(state);
}

/**
 * Update discoveries
 * @param discoveries - Discovery data to merge
 */
export function updateDiscoveries(discoveries: Partial<OnboardingState['discoveries']>): void {
  saveOnboardingState({ discoveries });
}

/**
 * Record a file creation
 * @param filePath - Path to the created file
 */
export function recordFileCreated(filePath: string): void {
  const state = loadOnboardingState() || DEFAULT_STATE;

  if (!state.filesCreated.includes(filePath)) {
    state.filesCreated.push(filePath);
    saveOnboardingState(state);
  }
}

/**
 * Clear onboarding state (call when onboarding completes)
 */
export function clearOnboardingState(): void {
  const statePath = getStatePath();

  if (existsSync(statePath)) {
    try {
      const fs = require('node:fs');
      fs.unlinkSync(statePath);
      console.log('[OnboardingState] Cleared state (onboarding complete)');
    } catch (error) {
      console.error('[OnboardingState] Failed to clear state:', error);
    }
  }
}

/**
 * Check if onboarding is in progress (has saved state but not complete)
 * @returns true if onboarding is in progress
 */
export function isOnboardingInProgress(): boolean {
  const state = loadOnboardingState();
  return state !== null && state.currentPhase < 10;
}

/**
 * Get resume prompt for continuing onboarding
 * @returns Resume context string or null if no state
 */
export function getResumeContext(): string | null {
  const state = loadOnboardingState();

  if (!state || state.currentPhase >= 10) {
    return null;
  }

  const parts: string[] = [
    '[ONBOARDING RESUME]',
    `Continuing from Phase ${state.currentPhase}`,
    `Completed phases: ${state.completedPhases.join(', ') || 'none'}`,
  ];

  if (state.discoveries.userName) {
    parts.push(`User name: ${state.discoveries.userName}`);
  }
  if (state.discoveries.agentName) {
    parts.push(`Agent name: ${state.discoveries.agentName}`);
  }
  if (state.discoveries.personalityType) {
    parts.push(`Personality: ${state.discoveries.personalityType}`);
  }
  if (state.discoveries.language) {
    parts.push(`Language: ${state.discoveries.language}`);
  }

  parts.push(`Files created: ${state.filesCreated.join(', ') || 'none'}`);
  parts.push('[/ONBOARDING RESUME]');

  return parts.join('\n');
}
