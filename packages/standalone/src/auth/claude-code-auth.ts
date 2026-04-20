import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeCodeAuthStatus {
  cliInstalled: boolean;
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  email: string | null;
  subscriptionType: string | null;
  source: 'cli_status' | 'legacy_credentials' | 'none';
  credentialsPath: string;
}

function defaultCredentialsPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, '.claude', '.credentials.json');
}

export function getClaudeCodeAuthStatus(command = 'claude'): ClaudeCodeAuthStatus {
  const credentialsPath = defaultCredentialsPath();

  try {
    const stdout = execFileSync(command, ['auth', 'status'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      env: process.env,
    });
    const parsed = JSON.parse(stdout) as {
      loggedIn?: boolean;
      authMethod?: string;
      apiProvider?: string;
      email?: string;
      subscriptionType?: string;
    };

    if (parsed.loggedIn) {
      return {
        cliInstalled: true,
        loggedIn: true,
        authMethod: parsed.authMethod ?? null,
        apiProvider: parsed.apiProvider ?? null,
        email: parsed.email ?? null,
        subscriptionType: parsed.subscriptionType ?? null,
        source: 'cli_status',
        credentialsPath,
      };
    }
  } catch (error) {
    const errorLike = error as NodeJS.ErrnoException | undefined;
    if (errorLike?.code === 'ENOENT') {
      if (existsSync(credentialsPath)) {
        return {
          cliInstalled: false,
          loggedIn: true,
          authMethod: 'legacy_credentials',
          apiProvider: 'firstParty',
          email: null,
          subscriptionType: null,
          source: 'legacy_credentials',
          credentialsPath,
        };
      }

      return {
        cliInstalled: false,
        loggedIn: false,
        authMethod: null,
        apiProvider: null,
        email: null,
        subscriptionType: null,
        source: 'none',
        credentialsPath,
      };
    }
  }

  if (existsSync(credentialsPath)) {
    return {
      cliInstalled: true,
      loggedIn: true,
      authMethod: 'legacy_credentials',
      apiProvider: 'firstParty',
      email: null,
      subscriptionType: null,
      source: 'legacy_credentials',
      credentialsPath,
    };
  }

  return {
    cliInstalled: true,
    loggedIn: false,
    authMethod: 'none',
    apiProvider: 'firstParty',
    email: null,
    subscriptionType: null,
    source: 'none',
    credentialsPath,
  };
}
