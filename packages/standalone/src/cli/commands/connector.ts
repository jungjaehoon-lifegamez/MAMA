/**
 * mama connector command
 *
 * Manage data source connectors (list, add, remove, status).
 * Config file: ~/.mama/connectors.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { Command } from 'commander';

import { AVAILABLE_CONNECTORS, loadConnector } from '../../connectors/index.js';
import type { ConnectorsConfig, ConnectorConfig } from '../../connectors/index.js';
import { visibleConnectorNames } from '../../connectors/private-connector-policy.js';

export interface ConnectorCommandOptions {
  configPath?: string;
  writeOut?: (line: string) => void;
  writeError?: (line: string) => void;
}

function loadConnectorsConfig(configPath: string): ConnectorsConfig {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as ConnectorsConfig;
  } catch {
    return {};
  }
}

function saveConnectorsConfig(configPath: string, config: ConnectorsConfig): void {
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function createConnectorCommand(options: ConnectorCommandOptions = {}): Command {
  const configPath = options.configPath ?? join(homedir(), '.mama', 'connectors.json');
  const writeOut = options.writeOut ?? ((line: string) => console.log(line));
  const writeError = options.writeError ?? ((line: string) => console.error(line));
  const cmd = new Command('connector').description('Manage data source connectors');

  // ── list ────────────────────────────────────────────────────────────────────
  cmd
    .command('list')
    .description('List all connectors and their status')
    .action(() => {
      const config = loadConnectorsConfig(configPath);

      writeOut('\nAvailable connectors:\n');
      for (const name of visibleConnectorNames(Object.keys(config))) {
        const connectorCfg = config[name];
        const enabled = connectorCfg?.enabled ?? false;
        const status = enabled ? '✓ enabled ' : '✗ disabled';
        const interval = connectorCfg?.pollIntervalMinutes
          ? ` (poll: ${connectorCfg.pollIntervalMinutes}m)`
          : '';
        writeOut(`  ${status}  ${name}${interval}`);
      }
      writeOut('');
    });

  // ── add ─────────────────────────────────────────────────────────────────────
  cmd
    .command('add <name>')
    .description('Enable a connector')
    .action(async (name: string) => {
      if (!(AVAILABLE_CONNECTORS as readonly string[]).includes(name)) {
        writeError(`Unknown connector: ${name}`);
        writeError(`Available: ${AVAILABLE_CONNECTORS.join(', ')}`);
        process.exitCode = 1;
        return;
      }

      const config = loadConnectorsConfig(configPath);

      // Build a default enabled config if not present
      if (!config[name]) {
        config[name] = {
          enabled: true,
          pollIntervalMinutes: 60,
          channels: {},
          auth: { type: 'none' },
        } satisfies ConnectorConfig;
      } else {
        config[name]!.enabled = true;
      }

      saveConnectorsConfig(configPath, config);
      writeOut(`\n✓ Connector '${name}' enabled.\n`);

      // Show auth requirements
      try {
        const connector = await loadConnector(name, config[name]);
        const reqs = connector.getAuthRequirements();
        if (reqs.length > 0) {
          writeOut('Auth requirements:');
          for (const req of reqs) {
            writeOut(`  • ${req.description}`);
            if (req.type === 'token' && req.tokenName) {
              writeOut(`    Set env: ${req.tokenName}`);
            }
            if (req.type === 'cli' && req.cliAuthCommand) {
              writeOut(`    Run: ${req.cliAuthCommand}`);
            }
          }
          writeOut('');
        }
      } catch {
        // Auth requirements display is best-effort
      }
    });

  // ── remove ──────────────────────────────────────────────────────────────────
  cmd
    .command('remove <name>')
    .description('Disable a connector')
    .action((name: string) => {
      const config = loadConnectorsConfig(configPath);
      const visibleNames = visibleConnectorNames(Object.keys(config));
      if (!visibleNames.includes(name)) {
        writeError(`Unknown connector: ${name}`);
        writeError(`Available: ${visibleNames.join(', ')}`);
        process.exitCode = 1;
        return;
      }

      if (!config[name]) {
        writeOut(`Connector '${name}' is already disabled (no config found).`);
        return;
      }

      config[name]!.enabled = false;
      saveConnectorsConfig(configPath, config);
      writeOut(`\n✓ Connector '${name}' disabled.\n`);
    });

  // ── status ──────────────────────────────────────────────────────────────────
  cmd
    .command('status')
    .description('Show connector health and last poll times')
    .action(async () => {
      const config = loadConnectorsConfig(configPath);
      const enabledNames = visibleConnectorNames(Object.keys(config)).filter(
        (name) => config[name]?.enabled === true
      );

      if (enabledNames.length === 0) {
        writeOut('\nNo connectors enabled. Run: mama connector add <name>\n');
        return;
      }

      writeOut('\nConnector health:\n');

      await Promise.all(
        enabledNames.map(async (name) => {
          let connector: Awaited<ReturnType<typeof loadConnector>> | undefined;
          try {
            connector = await loadConnector(name, config[name]);
            await connector.init();
            const health = await connector.healthCheck();

            const statusIcon = health.healthy ? '✓' : '✗';
            const lastPoll = health.lastPollTime ? health.lastPollTime.toLocaleString() : 'never';
            writeOut(`  ${statusIcon} ${name}`);
            writeOut(`      last poll: ${lastPoll}  items: ${health.lastPollCount}`);
            if (health.error) {
              writeOut(`      error: ${health.error}`);
            }
          } catch (err) {
            writeOut(`  ✗ ${name}`);
            writeOut(`      error: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            await connector?.dispose();
          }
        })
      );

      writeOut('');
    });

  return cmd;
}
