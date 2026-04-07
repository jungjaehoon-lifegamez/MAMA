/**
 * mama connector command
 *
 * Manage data source connectors (list, add, remove, status).
 * Config file: ~/.mama/connectors.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';

import { AVAILABLE_CONNECTORS, loadConnector } from '../../connectors/index.js';
import type { ConnectorsConfig, ConnectorConfig } from '../../connectors/index.js';

const CONNECTORS_CONFIG_PATH = join(homedir(), '.mama', 'connectors.json');

function loadConnectorsConfig(): ConnectorsConfig {
  if (!existsSync(CONNECTORS_CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONNECTORS_CONFIG_PATH, 'utf-8')) as ConnectorsConfig;
  } catch {
    return {};
  }
}

function saveConnectorsConfig(config: ConnectorsConfig): void {
  const dir = join(homedir(), '.mama');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONNECTORS_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

export function createConnectorCommand(): Command {
  const cmd = new Command('connector').description('Manage data source connectors');

  // ── list ────────────────────────────────────────────────────────────────────
  cmd
    .command('list')
    .description('List all connectors and their status')
    .action(() => {
      const config = loadConnectorsConfig();

      console.log('\nAvailable connectors:\n');
      for (const name of AVAILABLE_CONNECTORS) {
        const connectorCfg = config[name];
        const enabled = connectorCfg?.enabled ?? false;
        const status = enabled ? '✓ enabled ' : '✗ disabled';
        const interval = connectorCfg?.pollIntervalMinutes
          ? ` (poll: ${connectorCfg.pollIntervalMinutes}m)`
          : '';
        console.log(`  ${status}  ${name}${interval}`);
      }
      console.log('');
    });

  // ── add ─────────────────────────────────────────────────────────────────────
  cmd
    .command('add <name>')
    .description('Enable a connector')
    .action(async (name: string) => {
      if (!(AVAILABLE_CONNECTORS as readonly string[]).includes(name)) {
        console.error(`Unknown connector: ${name}`);
        console.error(`Available: ${AVAILABLE_CONNECTORS.join(', ')}`);
        process.exitCode = 1;
        return;
      }

      const config = loadConnectorsConfig();

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

      saveConnectorsConfig(config);
      console.log(`\n✓ Connector '${name}' enabled.\n`);

      // Show auth requirements
      try {
        const connector = await loadConnector(name, config[name]);
        const reqs = connector.getAuthRequirements();
        if (reqs.length > 0) {
          console.log('Auth requirements:');
          for (const req of reqs) {
            console.log(`  • ${req.description}`);
            if (req.type === 'token' && req.tokenName) {
              console.log(`    Set env: ${req.tokenName}`);
            }
            if (req.type === 'cli' && req.cliAuthCommand) {
              console.log(`    Run: ${req.cliAuthCommand}`);
            }
          }
          console.log('');
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
      if (!(AVAILABLE_CONNECTORS as readonly string[]).includes(name)) {
        console.error(`Unknown connector: ${name}`);
        console.error(`Available: ${AVAILABLE_CONNECTORS.join(', ')}`);
        process.exitCode = 1;
        return;
      }

      const config = loadConnectorsConfig();

      if (!config[name]) {
        console.log(`Connector '${name}' is already disabled (no config found).`);
        return;
      }

      config[name]!.enabled = false;
      saveConnectorsConfig(config);
      console.log(`\n✓ Connector '${name}' disabled.\n`);
    });

  // ── status ──────────────────────────────────────────────────────────────────
  cmd
    .command('status')
    .description('Show connector health and last poll times')
    .action(async () => {
      const config = loadConnectorsConfig();
      const enabledNames = AVAILABLE_CONNECTORS.filter((name) => config[name]?.enabled === true);

      if (enabledNames.length === 0) {
        console.log('\nNo connectors enabled. Run: mama connector add <name>\n');
        return;
      }

      console.log('\nConnector health:\n');

      await Promise.all(
        enabledNames.map(async (name) => {
          let connector: Awaited<ReturnType<typeof loadConnector>> | undefined;
          try {
            connector = await loadConnector(name, config[name]);
            await connector.init();
            const health = await connector.healthCheck();

            const statusIcon = health.healthy ? '✓' : '✗';
            const lastPoll = health.lastPollTime ? health.lastPollTime.toLocaleString() : 'never';
            console.log(`  ${statusIcon} ${name}`);
            console.log(`      last poll: ${lastPoll}  items: ${health.lastPollCount}`);
            if (health.error) {
              console.log(`      error: ${health.error}`);
            }
          } catch (err) {
            console.log(`  ✗ ${name}`);
            console.log(`      error: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            await connector?.dispose();
          }
        })
      );

      console.log('');
    });

  // ── config ──────────────────────────────────────────────────────────────────
  cmd
    .command('config <name>')
    .description('Configure channels for a connector')
    .option('--add-channel <id>', 'Add a channel/room/folder ID')
    .option('--role <role>', 'Set role: truth, hub, deliverable, spoke, reference, ignore', 'hub')
    .option('--channel-name <name>', 'Friendly name for the channel')
    .option('--remove-channel <id>', 'Remove a channel')
    .option('--poll-interval <minutes>', 'Set poll interval in minutes')
    .option('--list', 'List current channel config')
    .action(
      (
        name: string,
        opts: {
          addChannel?: string;
          role?: string;
          channelName?: string;
          removeChannel?: string;
          pollInterval?: string;
          list?: boolean;
        }
      ) => {
        if (!(AVAILABLE_CONNECTORS as readonly string[]).includes(name)) {
          console.error(`Unknown connector: ${name}`);
          console.error(`Available: ${AVAILABLE_CONNECTORS.join(', ')}`);
          process.exitCode = 1;
          return;
        }

        const config = loadConnectorsConfig();
        if (!config[name]) {
          console.error(`Connector '${name}' not configured. Run: mama connector add ${name}`);
          process.exitCode = 1;
          return;
        }

        const cc = config[name]!;

        // List channels
        if (opts.list || (!opts.addChannel && !opts.removeChannel && !opts.pollInterval)) {
          console.log(`\nConnector: ${name}`);
          console.log(`  Enabled: ${cc.enabled}`);
          console.log(`  Poll interval: ${cc.pollIntervalMinutes}m`);
          console.log(`  Auth: ${cc.auth.type}`);
          const channels = Object.entries(cc.channels);
          if (channels.length === 0) {
            console.log('  Channels: (none)');
          } else {
            console.log('  Channels:');
            for (const [id, ch] of channels) {
              const label = ch.name ? `${ch.name} (${id})` : id;
              console.log(`    ${label}  role=${ch.role}`);
            }
          }
          console.log('');
          return;
        }

        // Set poll interval
        if (opts.pollInterval) {
          const mins = parseInt(opts.pollInterval, 10);
          if (isNaN(mins) || mins < 1) {
            console.error('Poll interval must be a positive integer (minutes)');
            process.exitCode = 1;
            return;
          }
          cc.pollIntervalMinutes = mins;
          console.log(`✓ Poll interval set to ${mins} minutes`);
        }

        // Add channel
        if (opts.addChannel) {
          const validRoles = ['truth', 'hub', 'deliverable', 'spoke', 'reference', 'ignore'];
          const role = opts.role ?? 'hub';
          if (!validRoles.includes(role)) {
            console.error(`Invalid role: ${role}. Valid: ${validRoles.join(', ')}`);
            process.exitCode = 1;
            return;
          }
          cc.channels[opts.addChannel] = {
            role: role as 'truth' | 'hub' | 'deliverable' | 'spoke' | 'reference' | 'ignore',
            ...(opts.channelName ? { name: opts.channelName } : {}),
          };
          console.log(`✓ Channel '${opts.addChannel}' added with role=${role}`);
        }

        // Remove channel
        if (opts.removeChannel) {
          if (cc.channels[opts.removeChannel]) {
            delete cc.channels[opts.removeChannel];
            console.log(`✓ Channel '${opts.removeChannel}' removed`);
          } else {
            console.log(`Channel '${opts.removeChannel}' not found`);
          }
        }

        saveConnectorsConfig(config);
        console.log('Config saved. Restart MAMA OS to apply.\n');
      }
    );

  return cmd;
}
