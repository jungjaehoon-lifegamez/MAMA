/**
 * HealthCheckService — connection-based system health checks
 *
 * Extends the statistics-based HealthScoreService with real connection status checks.
 * Checks gateway connections, embedding server, database, sessions, memory, and schedulers.
 */

import http from 'node:http';
import fs from 'node:fs';

// === Types ===

export type CheckSeverity = 'critical' | 'warning' | 'info';
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface HealthCheckResult {
  name: string;
  severity: CheckSeverity;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface SystemHealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  score: number;
  checks: HealthCheckResult[];
  summary: {
    critical: { pass: number; fail: number };
    warning: { pass: number; fail: number };
    info: { pass: number; fail: number };
  };
  timestamp: number;
  metrics?: unknown;
}

export interface HealthCheckDeps {
  gateways?: Map<string, { isConnected(): boolean }>;
  embeddingPort?: number;
  db?: { prepare(sql: string): { get(): unknown } };
  sessionPool?: { getActiveSessionCount(): number };
  cronScheduler?: {
    listJobs(): Array<{ enabled: boolean; isRunning: boolean; lastRun?: Date; nextRun?: Date }>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  heartbeat?: any;
  metricsCleanup?: { isRunning(): boolean };
  getAgentStates?: () => Map<string, string>;
  getTokenUsage?: () => { used: number; limit: number; alertThreshold?: number } | null;
  getActiveDelegationCount?: () => number;
  watchdogPidPath?: string;
  healthScoreService?: { compute(windowMs?: number): unknown };
  dbPath?: string;
}

// === Service ===

export class HealthCheckService {
  private deps: HealthCheckDeps;

  constructor(deps: HealthCheckDeps) {
    this.deps = { ...deps };
    if (!this.deps.gateways) {
      this.deps.gateways = new Map();
    }
  }

  addGateway(name: string, gateway: { isConnected(): boolean }): void {
    this.deps.gateways!.set(name, gateway);
  }

  setCronScheduler(scheduler: HealthCheckDeps['cronScheduler']): void {
    this.deps.cronScheduler = scheduler;
  }

  setHeartbeat(heartbeat: HealthCheckDeps['heartbeat']): void {
    this.deps.heartbeat = heartbeat;
  }

  setGetAgentStates(fn: HealthCheckDeps['getAgentStates']): void {
    this.deps.getAgentStates = fn;
  }

  setGetTokenUsage(fn: HealthCheckDeps['getTokenUsage']): void {
    this.deps.getTokenUsage = fn;
  }

  setGetActiveDelegationCount(fn: HealthCheckDeps['getActiveDelegationCount']): void {
    this.deps.getActiveDelegationCount = fn;
  }

  async check(): Promise<SystemHealthReport> {
    const checks: HealthCheckResult[] = [];

    // Critical
    this.checkGateways(checks);
    await this.checkEmbeddingServer(checks);
    this.checkDatabase(checks);
    this.checkSessionPool(checks);

    // Warning
    this.checkMemory(checks);
    this.checkDiskUsage(checks);
    this.checkTokenBudget(checks);
    this.checkAgentProcesses(checks);
    this.checkDelegationChains(checks);

    // Info
    this.checkCronScheduler(checks);
    this.checkHeartbeat(checks);
    this.checkWatchdog(checks);
    this.checkMetricsCleanup(checks);

    return this.buildReport(checks);
  }

  // --- Critical checks ---

  private checkGateways(checks: HealthCheckResult[]): void {
    const gateways = this.deps.gateways;
    if (!gateways || gateways.size === 0) return;

    for (const [name, gw] of gateways) {
      const connected = gw.isConnected();
      checks.push({
        name,
        severity: 'critical',
        status: connected ? 'pass' : 'fail',
        message: connected ? 'Connected' : 'Disconnected',
      });
    }
  }

  private checkEmbeddingServer(checks: HealthCheckResult[]): Promise<void> {
    const port = this.deps.embeddingPort;
    if (!port) {
      checks.push({
        name: 'embedding',
        severity: 'critical',
        status: 'skip',
        message: 'No embedding port configured',
      });
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 1000 },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              const modelLoaded = json.modelLoaded !== false;
              checks.push({
                name: 'embedding',
                severity: 'critical',
                status: modelLoaded ? 'pass' : 'fail',
                message: modelLoaded ? 'OK (model loaded)' : 'Model not loaded',
                detail: json.model ? `Model: ${json.model}` : undefined,
              });
            } catch {
              checks.push({
                name: 'embedding',
                severity: 'critical',
                status: 'warn',
                message: 'Server responded but invalid JSON',
              });
            }
            resolve();
          });
        }
      );
      req.on('error', () => {
        checks.push({
          name: 'embedding',
          severity: 'critical',
          status: 'fail',
          message: 'Server unreachable',
        });
        resolve();
      });
      req.on('timeout', () => {
        req.destroy();
        checks.push({
          name: 'embedding',
          severity: 'critical',
          status: 'fail',
          message: 'Server timeout (>1s)',
        });
        resolve();
      });
      req.end();
    });
  }

  private checkDatabase(checks: HealthCheckResult[]): void {
    if (!this.deps.db) {
      checks.push({
        name: 'database',
        severity: 'critical',
        status: 'skip',
        message: 'No database provided',
      });
      return;
    }
    try {
      this.deps.db.prepare('SELECT 1').get();
      checks.push({
        name: 'database',
        severity: 'critical',
        status: 'pass',
        message: 'OK',
      });
    } catch (e) {
      checks.push({
        name: 'database',
        severity: 'critical',
        status: 'fail',
        message: 'Query failed',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private checkSessionPool(checks: HealthCheckResult[]): void {
    if (!this.deps.sessionPool) {
      checks.push({
        name: 'cli_sessions',
        severity: 'critical',
        status: 'skip',
        message: 'No session pool',
      });
      return;
    }
    const count = this.deps.sessionPool.getActiveSessionCount();
    const status: CheckStatus = count >= 100 ? 'warn' : 'pass';
    checks.push({
      name: 'cli_sessions',
      severity: 'critical',
      status,
      message: `${count} active session(s)`,
      detail: count >= 100 ? 'Session pool near capacity' : undefined,
    });
  }

  // --- Warning checks ---

  private checkMemory(checks: HealthCheckResult[]): void {
    const heapUsed = process.memoryUsage().heapUsed;
    const mb = Math.round(heapUsed / (1024 * 1024));
    let status: CheckStatus = 'pass';
    let message = `${mb}MB`;
    if (mb > 1024) {
      status = 'fail';
      message = `${mb}MB (critical)`;
    } else if (mb > 512) {
      status = 'warn';
      message = `${mb}MB (high)`;
    }
    checks.push({ name: 'memory', severity: 'warning', status, message });
  }

  private checkDiskUsage(checks: HealthCheckResult[]): void {
    const dbPath = this.deps.dbPath;
    if (!dbPath) {
      return;
    }
    try {
      const stat = fs.statSync(dbPath);
      const mb = Math.round(stat.size / (1024 * 1024));
      const status: CheckStatus = mb > 1024 ? 'warn' : 'pass';
      checks.push({
        name: 'disk',
        severity: 'warning',
        status,
        message: `DB ${mb}MB`,
        detail: mb > 1024 ? 'Database file exceeds 1GB' : undefined,
      });
    } catch {
      // DB file not accessible — skip
    }
  }

  private checkTokenBudget(checks: HealthCheckResult[]): void {
    if (!this.deps.getTokenUsage) return;
    const usage = this.deps.getTokenUsage();
    if (!usage || usage.limit <= 0) return;

    const threshold = usage.alertThreshold ?? 0.9;
    const ratio = usage.used / usage.limit;
    const pct = Math.round(ratio * 100);
    const usedK = Math.round(usage.used / 1000);
    const limitK = Math.round(usage.limit / 1000);
    let status: CheckStatus = 'pass';
    let message = `${pct}% (${usedK}K/${limitK}K)`;
    if (ratio > 1.0) {
      status = 'fail';
      message = `${pct}% — over budget (${usedK}K/${limitK}K)`;
    } else if (ratio > threshold) {
      status = 'warn';
      message = `${pct}% — near limit (${usedK}K/${limitK}K)`;
    }
    checks.push({ name: 'token_budget', severity: 'warning', status, message });
  }

  private checkAgentProcesses(checks: HealthCheckResult[]): void {
    if (!this.deps.getAgentStates) return;
    try {
      const states = this.deps.getAgentStates();
      if (states.size === 0) return;

      const dead = Array.from(states.entries()).filter(([, s]) => s === 'dead');
      if (dead.length > 0) {
        checks.push({
          name: 'agent_processes',
          severity: 'warning',
          status: 'warn',
          message: `${dead.length} dead agent(s)`,
          detail: dead.map(([id]) => id).join(', '),
        });
      } else {
        checks.push({
          name: 'agent_processes',
          severity: 'warning',
          status: 'pass',
          message: `${states.size} agent(s) OK`,
        });
      }
    } catch {
      // ignore
    }
  }

  private checkDelegationChains(checks: HealthCheckResult[]): void {
    if (!this.deps.getActiveDelegationCount) return;
    try {
      const count = this.deps.getActiveDelegationCount();
      if (count > 5) {
        checks.push({
          name: 'delegation_chains',
          severity: 'warning',
          status: 'warn',
          message: `${count} active chains (possible stuck)`,
        });
      } else {
        checks.push({
          name: 'delegation_chains',
          severity: 'warning',
          status: 'pass',
          message: `${count} active chain(s)`,
        });
      }
    } catch {
      // ignore
    }
  }

  // --- Info checks ---

  private checkWatchdog(checks: HealthCheckResult[]): void {
    const pidPath = this.deps.watchdogPidPath;
    if (!pidPath) return;
    try {
      if (!fs.existsSync(pidPath)) {
        checks.push({
          name: 'watchdog',
          severity: 'info',
          status: 'warn',
          message: 'No PID file',
        });
        return;
      }
      const content = fs.readFileSync(pidPath, 'utf-8');
      const info = JSON.parse(content);
      if (typeof info.pid === 'number') {
        // Check if process is alive via kill(pid, 0)
        try {
          process.kill(info.pid, 0);
          checks.push({
            name: 'watchdog',
            severity: 'info',
            status: 'pass',
            message: `Active (PID ${info.pid})`,
          });
        } catch {
          checks.push({
            name: 'watchdog',
            severity: 'info',
            status: 'warn',
            message: `Dead (PID ${info.pid})`,
          });
        }
      }
    } catch {
      // ignore
    }
  }

  private checkCronScheduler(checks: HealthCheckResult[]): void {
    if (!this.deps.cronScheduler) return;
    try {
      const jobs = this.deps.cronScheduler.listJobs();
      const enabled = jobs.filter((j) => j.enabled);
      const running = jobs.filter((j) => j.isRunning);
      const missed = enabled.filter((j) => {
        if (!j.nextRun || !j.lastRun) return false;
        return j.lastRun.getTime() > j.nextRun.getTime();
      });

      let status: CheckStatus = 'pass';
      let message = `${enabled.length} job(s) active`;
      if (running.length > 0) message += `, ${running.length} running`;
      if (missed.length > 0) {
        status = 'warn';
        message += `, ${missed.length} possibly missed`;
      }
      checks.push({ name: 'cron', severity: 'info', status, message });
    } catch {
      // ignore
    }
  }

  private checkHeartbeat(checks: HealthCheckResult[]): void {
    if (!this.deps.heartbeat) return;
    const hb = this.deps.heartbeat as Record<string, unknown>;
    const running =
      typeof hb.isRunning === 'function' ? (hb.isRunning as () => boolean)() : hb.running === true;
    checks.push({
      name: 'heartbeat',
      severity: 'info',
      status: running ? 'pass' : 'warn',
      message: running ? 'Running' : 'Stopped',
    });
  }

  private checkMetricsCleanup(checks: HealthCheckResult[]): void {
    if (!this.deps.metricsCleanup) return;
    const running = this.deps.metricsCleanup.isRunning();
    checks.push({
      name: 'metrics_cleanup',
      severity: 'info',
      status: running ? 'pass' : 'warn',
      message: running ? 'Active' : 'Stopped',
    });
  }

  // --- Report builder ---

  private buildReport(checks: HealthCheckResult[]): SystemHealthReport {
    const summary = {
      critical: { pass: 0, fail: 0 },
      warning: { pass: 0, fail: 0 },
      info: { pass: 0, fail: 0 },
    };

    for (const c of checks) {
      if (c.status === 'skip') continue;
      const bucket = summary[c.severity];
      if (c.status === 'pass') {
        bucket.pass++;
      } else {
        bucket.fail++;
      }
    }

    let score = 100;
    score -= summary.critical.fail * 30;
    score -= summary.warning.fail * 10;
    score -= summary.info.fail * 2;
    score = Math.max(0, Math.min(100, score));

    const status: SystemHealthReport['status'] =
      score >= 80 ? 'healthy' : score >= 50 ? 'degraded' : 'unhealthy';

    const metrics = this.deps.healthScoreService?.compute();

    return { status, score, checks, summary, timestamp: Date.now(), metrics };
  }
}
