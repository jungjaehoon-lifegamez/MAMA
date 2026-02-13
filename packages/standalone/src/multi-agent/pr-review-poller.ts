/**
 * PR Review Poller
 *
 * Polls GitHub PR for new review comments and injects them into Slack channel.
 * Enables autonomous Sisyphus → DevBot → push → review → fix → push loop.
 *
 * Flow:
 * 1. Agent pushes and posts PR URL in channel
 * 2. Poller detects URL → starts polling `gh api` every 60s
 * 3. New review comments → posted through callback (e.g., as lightweight reminders)
 * 4. Sisyphus analyzes severity → delegates fixes to @DevBot
 * 5. DevBot fixes → @Reviewer → approve or request changes
 * 6. Poller detects new comments or Approved → loop continues or ends
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile, unlink } from 'fs/promises';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import { splitForDiscord } from '../gateways/message-splitter.js';

const execFileAsync = promisify(execFile);
const { DebugLogger } = debugLogger as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};

/** Default polling interval (60 seconds) */
const POLL_INTERVAL_MS = 60 * 1000;

/** Reminder interval for unresolved threads (15 minutes) */
const REMIND_INTERVAL_MS = 15 * 60 * 1000;

/** Max polling duration before auto-stop (2 hours) */
const MAX_POLL_DURATION_MS = 2 * 60 * 60 * 1000;

/** Marker prefix for auto-reply comments */
const FIXED_REPLY_PREFIX = '✅ Fixed in';

/**
 * Single PR review comment from GitHub API
 */
interface PRComment {
  id: number;
  path: string;
  line: number | null;
  body: string;
  user: { login: string };
  created_at: string;
}

/**
 * Unresolved review thread from GitHub GraphQL API
 */
interface ReviewThread {
  id: string; // GraphQL node ID
  isResolved: boolean;
  comments: {
    path: string;
    line: number | null;
    body: string;
    author: string;
  }[];
}

/**
 * PR review state from GitHub API
 */
interface PRReview {
  id: number;
  state: string; // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED
  user: { login: string };
  submitted_at: string;
}

type PRPollerItemKind = 'review' | 'comment' | 'thread';
type PRPollerSeverity = 'high' | 'medium' | 'low';

export interface PRPollerBatchItem {
  id: string;
  kind: PRPollerItemKind;
  severity: PRPollerSeverity;
  summary: string;
  isReminder: boolean;
}

export interface PRPollerBatchDigest {
  items: PRPollerBatchItem[];
  newItems: PRPollerBatchItem[];
  reminderItems: PRPollerBatchItem[];
}

/**
 * Active polling session
 */
interface PollSession {
  owner: string;
  repo: string;
  prNumber: number;
  channelId: string;
  timeoutId: ReturnType<typeof setTimeout> | null;
  seenCommentIds: Set<number>;
  seenReviewIds: Set<number>;
  addressedCommentIds: Set<number>;
  seenUnresolvedThreadIds: Map<string, number>; // id → last reported timestamp
  lastUnresolvedReminderAt: number;
  lastHeadSha: string | null;
  isPolling: boolean; // Prevent concurrent polling
  startedAt: number;
  workspaceDir: string;
}

/**
 * Callback for sending messages to Slack
 */
type MessageSender = (channelId: string, text: string) => Promise<void>;
type BatchItemCallback = (
  channelId: string,
  summary: string,
  item: PRPollerBatchItem
) => Promise<void>;

/**
 * PR Review Poller
 *
 * Watches GitHub PRs for new review comments and routes them to agents.
 */
export class PRReviewPoller {
  private sessions: Map<string, PollSession> = new Map();
  private messageSender: MessageSender | null = null;
  private onBatchItem: BatchItemCallback | null = null;
  private onBatchComplete:
    | ((channelId: string, digest?: PRPollerBatchDigest) => Promise<void>)
    | null = null;
  private logger = new DebugLogger('PRReviewPoller');

  /**
   * Check if a message sender is already configured
   */
  hasMessageSender(): boolean {
    return this.messageSender !== null;
  }

  /**
   * Set the message sender callback (Slack WebClient wrapper)
   */
  setMessageSender(sender: MessageSender): void {
    this.messageSender = sender;
  }

  /**
   * Set callback fired once per logical poll item (before chunking/sending).
   * Useful for counting poll items and passing compact summaries upstream.
   */
  setOnBatchItem(callback: BatchItemCallback): void {
    this.onBatchItem = callback;
  }

  /**
   * Set callback fired after all message chunks for a poll cycle are sent.
   * Used by handlers to trigger lead wake-up once per poll cycle (not per-chunk).
   */
  setOnBatchComplete(
    callback: (channelId: string, digest?: PRPollerBatchDigest) => Promise<void>
  ): void {
    this.onBatchComplete = callback;
  }

  /**
   * Set the target agent's Slack user ID for @mentions in review messages
   * (typically the orchestrator/Sisyphus, who analyzes and delegates to DevBot)
   */
  private targetAgentUserId?: string;
  setTargetAgentUserId(userId: string): void {
    this.targetAgentUserId = userId;
  }

  /**
   * Start polling a PR for review comments
   *
   * @param prUrl - GitHub PR URL (e.g., https://github.com/owner/repo/pull/14)
   * @param channelId - Slack channel to post updates to
   */
  async startPolling(prUrl: string, channelId: string): Promise<boolean> {
    const parsed = this.parsePRUrl(prUrl);
    if (!parsed) {
      this.logger.error(`[PRPoller] Invalid PR URL: ${prUrl}`);
      return false;
    }

    const sessionKey = `${parsed.owner}/${parsed.repo}#${parsed.prNumber}`;

    // Already polling this PR
    if (this.sessions.has(sessionKey)) {
      this.logger.info(`[PRPoller] Already polling ${sessionKey}`);
      return true;
    }

    // Load existing comments to avoid re-reporting
    const seenCommentIds = new Set<number>();
    const seenReviewIds = new Set<number>();

    try {
      const existingComments = await this.fetchComments(parsed.owner, parsed.repo, parsed.prNumber);
      for (const c of existingComments) {
        seenCommentIds.add(c.id);
      }

      const existingReviews = await this.fetchReviews(parsed.owner, parsed.repo, parsed.prNumber);
      for (const r of existingReviews) {
        seenReviewIds.add(r.id);
      }
    } catch (err) {
      this.logger.error(`[PRPoller] Failed to load existing comments — aborting start:`, err);
      return false;
    }

    // Fetch initial HEAD SHA
    let lastHeadSha: string | null = null;
    try {
      lastHeadSha = await this.fetchHeadSha(parsed.owner, parsed.repo, parsed.prNumber);
    } catch {
      // Non-critical, will be fetched on first poll
    }

    // Checkout PR branch before starting work (isolated workspace)
    const workspaceRoot = process.env.MAMA_WORKSPACE || join(homedir(), '.mama', 'workspace');
    const workspaceDir = await this.prepareWorkspace(workspaceRoot, parsed);
    try {
      await this.ensureGhAuth();
      await this.ensureRepo(workspaceDir, parsed.owner, parsed.repo);
      await this.withWorkspaceLock(workspaceDir, async () => {
        await execFileAsync('gh', ['pr', 'checkout', String(parsed.prNumber)], {
          timeout: 30000,
          cwd: workspaceDir,
        });
      });
      this.logger.info(`[PRPoller] Checked out PR #${parsed.prNumber} branch in ${workspaceDir}`);
    } catch (err) {
      this.logger.error(`[PRPoller] Failed to checkout PR branch — aborting start:`, err);
      return false;
    }

    const session: PollSession = {
      ...parsed,
      channelId,
      seenCommentIds,
      seenReviewIds,
      addressedCommentIds: new Set<number>(),
      seenUnresolvedThreadIds: new Map<string, number>(),
      lastUnresolvedReminderAt: 0,
      lastHeadSha,
      startedAt: Date.now(),
      isPolling: false,
      timeoutId: null,
      workspaceDir,
    };

    this.sessions.set(sessionKey, session);
    this.logger.info(
      `[PRPoller] Started polling ${sessionKey} (${seenCommentIds.size} existing comments, interval: ${POLL_INTERVAL_MS / 1000}s)`
    );

    // Run first poll immediately, then schedule next
    this.poll(sessionKey).catch((err) => {
      this.logger.error(`[PRPoller] Initial poll error for ${sessionKey}:`, err);
    });

    return true;
  }

  /**
   * Stop polling a PR
   */
  stopPolling(prUrl: string): void {
    const parsed = this.parsePRUrl(prUrl);
    if (!parsed) return;

    const sessionKey = `${parsed.owner}/${parsed.repo}#${parsed.prNumber}`;
    const session = this.sessions.get(sessionKey);
    if (session) {
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
      }
      this.sessions.delete(sessionKey);
      this.logger.info(`[PRPoller] Stopped polling ${sessionKey}`);
    }
  }

  /**
   * Stop all polling sessions
   */
  stopAll(): void {
    for (const [key, session] of this.sessions) {
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
      }
      this.logger.info(`[PRPoller] Stopped polling ${key}`);
    }
    this.sessions.clear();
  }

  /**
   * Get active polling sessions
   */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get session details for active polling sessions (for auto-commit)
   */
  getSessionDetails(): {
    owner: string;
    repo: string;
    prNumber: number;
    channelId: string;
    workspaceDir: string;
  }[] {
    return Array.from(this.sessions.values()).map((s) => ({
      owner: s.owner,
      repo: s.repo,
      prNumber: s.prNumber,
      channelId: s.channelId,
      workspaceDir: s.workspaceDir,
    }));
  }

  /**
   * Schedule the next poll cycle for a session
   */
  private scheduleNextPoll(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    session.timeoutId = setTimeout(() => {
      this.poll(sessionKey).catch((err) => {
        this.logger.error(`[PRPoller] Poll error for ${sessionKey}:`, err);
      });
    }, POLL_INTERVAL_MS);
  }

  /**
   * Poll a single PR for new comments/reviews
   */
  private async poll(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    // Prevent concurrent polling
    if (session.isPolling) {
      this.logger.info(
        `[PRPoller] Skipping concurrent poll for ${sessionKey} (already in progress)`
      );
      return;
    }

    session.isPolling = true;
    // Track batch items discovered in this poll cycle.
    const cycleDigest: PRPollerBatchDigest = {
      items: [],
      newItems: [],
      reminderItems: [],
    };
    const seenItemIds = new Set<string>();

    const registerItem = async (text: string, item: PRPollerBatchItem): Promise<void> => {
      if (!this.addPollerBatchItem(session.channelId, item, cycleDigest, seenItemIds)) {
        return;
      }

      await this.sendMessage(session.channelId, text, item);
      this.logger.info(
        `[PRPoller] Sent ${item.kind} item for ${sessionKey}${item.isReminder ? ' (reminder)' : ''}: ${item.id}`
      );
    };

    try {
      // Auto-stop after max duration
      if (Date.now() - session.startedAt > MAX_POLL_DURATION_MS) {
        this.logger.info(`[PRPoller] Max duration reached for ${sessionKey}, stopping`);
        if (session.timeoutId) {
          clearTimeout(session.timeoutId);
        }
        this.sessions.delete(sessionKey);
        await this.sendMessage(
          session.channelId,
          `⏰ *PR Review Poller* — ${sessionKey} auto-stopped after 2h. Re-post the PR URL to restart.`
        );
        return;
      }

      // Check PR state first
      try {
        const prState = await this.fetchPRState(session.owner, session.repo, session.prNumber);
        if (prState === 'MERGED' || prState === 'CLOSED') {
          this.logger.info(`[PRPoller] PR ${sessionKey} is ${prState}, stopping`);
          if (session.timeoutId) {
            clearTimeout(session.timeoutId);
          }
          this.sessions.delete(sessionKey);
          await this.sendMessage(
            session.channelId,
            `✅ *PR Review Poller* — ${sessionKey} ${prState}. Polling stopped.`
          );
          return;
        }
      } catch {
        // Ignore state check errors, continue polling
      }

      // Fetch new reviews
      try {
        const reviews = await this.fetchReviews(session.owner, session.repo, session.prNumber);
        const newReviews = reviews.filter((r) => !session.seenReviewIds.has(r.id));

        for (const review of newReviews) {
          session.seenReviewIds.add(review.id);

          if (review.state === 'APPROVED') {
            const summary = `✅ *PR Review* — ${sessionKey} **APPROVED** by ${review.user.login}. Polling stopped.`;
            const item: PRPollerBatchItem = {
              id: `${sessionKey}:review:${review.id}`,
              kind: 'review',
              severity: 'high',
              summary,
              isReminder: false,
            };
            try {
              await registerItem(summary, item);

              // Trigger onBatchComplete for follow-up workflow.
              if (this.onBatchComplete) {
                try {
                  await this.onBatchComplete(session.channelId, cycleDigest);
                } catch (err) {
                  this.logger.error(`[PRPoller] onBatchComplete error after APPROVE:`, err);
                }
              }
            } finally {
              if (session.timeoutId) {
                clearTimeout(session.timeoutId);
              }
              this.sessions.delete(sessionKey);
            }
            return;
          }

          if (review.state === 'CHANGES_REQUESTED') {
            const summary = `🔴 *PR Review* — ${sessionKey} **CHANGES REQUESTED** by ${review.user.login}`;
            const item: PRPollerBatchItem = {
              id: `${sessionKey}:review:${review.id}`,
              kind: 'review',
              severity: 'high',
              summary,
              isReminder: false,
            };
            await registerItem(summary, item);
          }
        }
      } catch (err) {
        this.logger.error(`[PRPoller] Failed to fetch reviews:`, err);
      }

      // Detect new push (HEAD SHA changed)
      let newPush = false;
      let changedFiles: string[] = [];
      try {
        const currentSha = await this.fetchHeadSha(session.owner, session.repo, session.prNumber);
        if (session.lastHeadSha && currentSha !== session.lastHeadSha) {
          newPush = true;
          changedFiles = await this.fetchChangedFiles(
            session.owner,
            session.repo,
            session.lastHeadSha,
            currentSha
          );
          this.logger.info(
            `[PRPoller] New push detected for ${sessionKey}: ${session.lastHeadSha.substring(0, 7)} → ${currentSha.substring(0, 7)} (${changedFiles.length} files changed)`
          );
          session.lastHeadSha = currentSha;
        } else if (!session.lastHeadSha) {
          session.lastHeadSha = currentSha;
        }
      } catch (err) {
        this.logger.error(`[PRPoller] Failed to detect push:`, err);
      }

      // Fetch comments once (avoid N+1 API calls between handlePostPush and standard flow)
      let allComments: PRComment[] = [];
      try {
        allComments = await this.fetchComments(session.owner, session.repo, session.prNumber);
      } catch (err) {
        this.logger.error(`[PRPoller] Failed to fetch comments:`, err);
        return; // Cannot proceed without comments
      }

      // After a push, check unresolved threads and auto-reply to addressed ones
      if (newPush && changedFiles.length > 0) {
        try {
          await this.handlePostPush(session, changedFiles, allComments);
        } catch (err) {
          this.logger.error(`[PRPoller] Failed to handle post-push:`, err);
        }
      }

      // Standard flow: filter and send new comments
      try {
        const newComments = allComments.filter(
          (c) => !session.seenCommentIds.has(c.id) && !session.addressedCommentIds.has(c.id)
        );

        if (newComments.length > 0) {
          // Format and send new comments
          const formatted = this.formatComments(sessionKey, newComments);
          const mention = this.targetAgentUserId ? `<@${this.targetAgentUserId}> ` : '';
          const summary = `${mention}${formatted}`;
          const item: PRPollerBatchItem = {
            id: `${sessionKey}:comments:${newComments.map((comment) => comment.id).join(',')}`,
            kind: 'comment',
            severity: this.classifyCommentBatchSeverity(newComments),
            summary: summary,
            isReminder: false,
          };
          await registerItem(summary, item);

          // Mark as seen only after successful send
          for (const c of newComments) {
            session.seenCommentIds.add(c.id);
          }
          this.logger.info(`[PRPoller] Sent ${newComments.length} new comments for ${sessionKey}`);
        }
      } catch (err) {
        this.logger.error(`[PRPoller] Failed to process comments:`, err);
      }

      // Check unresolved threads every cycle (not just after push)
      try {
        const threads = await this.fetchUnresolvedThreads(
          session.owner,
          session.repo,
          session.prNumber
        );
        const allUnresolved = threads.filter((t) => !t.isResolved);
        const now = Date.now();

        // Report unresolved threads only when they are first seen, and remind at bounded intervals.
        const toReport = allUnresolved.filter((t) => {
          const lastReported = session.seenUnresolvedThreadIds.get(t.id);
          return !lastReported;
        });

        const needsReminder =
          toReport.length === 0 &&
          now - session.lastUnresolvedReminderAt >= REMIND_INTERVAL_MS &&
          allUnresolved.length > 0;

        if (needsReminder) {
          toReport.push(...allUnresolved.slice(0, 20));
        }

        if (toReport.length > 0) {
          const isReminder = needsReminder;
          const prefix = isReminder ? '🔔 *Reminder*: ' : '';
          const formatted = this.formatUnresolvedThreads(sessionKey, toReport, threads.length);
          const mention = this.targetAgentUserId ? `<@${this.targetAgentUserId}> ` : '';
          const summary = `${mention}${prefix}${formatted}`;
          const item: PRPollerBatchItem = {
            id: `${sessionKey}:threads:${toReport.map((thread) => thread.id).join(':')}`,
            kind: 'thread',
            severity: 'high',
            summary,
            isReminder,
          };
          await registerItem(summary, item);

          for (const t of toReport) {
            session.seenUnresolvedThreadIds.set(t.id, now);
          }
          // Update lastUnresolvedReminderAt on all notifications (not just reminders)
          // to prevent immediate reminder on the next poll after initial report
          session.lastUnresolvedReminderAt = now;
          this.logger.info(
            `[PRPoller] Sent ${toReport.length} unresolved threads for ${sessionKey}${isReminder ? ' (reminder)' : ''}`
          );
        }

        // Clean up resolved threads from seen map
        const unresolvedIds = new Set(allUnresolved.map((t) => t.id));
        for (const [id] of session.seenUnresolvedThreadIds) {
          if (!unresolvedIds.has(id)) {
            session.seenUnresolvedThreadIds.delete(id);
          }
        }
      } catch (err) {
        this.logger.error(`[PRPoller] Failed to check unresolved threads:`, err);
      }

      // Notify batch complete — triggers agent processing once after all chunks (only when new data found)
      if (
        cycleDigest.newItems.length + cycleDigest.reminderItems.length > 0 &&
        this.onBatchComplete
      ) {
        try {
          await this.onBatchComplete(session.channelId, cycleDigest);
        } catch (err) {
          this.logger.error(`[PRPoller] onBatchComplete error:`, err);
        }
      }
    } finally {
      // Always reset polling flag to allow next poll
      session.isPolling = false;

      // Schedule next poll if session still exists
      if (this.sessions.has(sessionKey)) {
        this.scheduleNextPoll(sessionKey);
      }
    }
  }

  /**
   * Format PR comments with full details grouped by file.
   * Enables parallel delegation — independent files can be fixed simultaneously.
   */
  private classifyCommentBatchSeverity(comments: PRComment[]): PRPollerSeverity {
    const hasFixHint = comments.some(
      (comment) =>
        comment.body.toLowerCase().includes('must') || comment.body.toLowerCase().includes('fail')
    );

    return hasFixHint ? 'high' : comments.length > 2 ? 'medium' : 'low';
  }

  private addPollerBatchItem(
    channelId: string,
    item: PRPollerBatchItem,
    digest: PRPollerBatchDigest,
    seenItemIds: Set<string>
  ): boolean {
    if (seenItemIds.has(item.id)) {
      return false;
    }

    seenItemIds.add(item.id);
    digest.items.push(item);

    if (item.isReminder) {
      digest.reminderItems.push(item);
    } else {
      digest.newItems.push(item);
    }

    if (this.onBatchItem) {
      this.onBatchItem(channelId, this.extractBatchSummary(item.summary), item).catch((err) => {
        this.logger.error('[PRPoller] Failed to report batch item:', err);
      });
    }

    return true;
  }

  private formatComments(sessionKey: string, comments: PRComment[]): string {
    // Group by file
    const byFile = new Map<string, PRComment[]>();
    for (const c of comments) {
      const key = c.path || '(general)';
      const list = byFile.get(key) || [];
      list.push(c);
      byFile.set(key, list);
    }

    const lines: string[] = [
      `📝 PR ${sessionKey} — ${comments.length} new review comments across ${byFile.size} file(s)`,
      '',
    ];

    for (const [file, fileComments] of byFile) {
      lines.push(`**${file}**`);
      for (const c of fileComments) {
        const lineRef = c.line ? `:${c.line}` : '';
        const body = c.body.length > 200 ? c.body.substring(0, 200) + '…' : c.body;
        lines.push(`  • L${lineRef} ${body}`);
      }
      lines.push('');
    }

    if (byFile.size > 1) {
      lines.push(
        `💡 ${byFile.size} files — delegate in parallel when independent; keep coupled changes together (DELEGATE_BG)`
      );
    }

    return lines.join('\n');
  }

  /**
   * Fetch PR review comments via gh API
   */
  private async fetchComments(owner: string, repo: string, prNumber: number): Promise<PRComment[]> {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        '--paginate',
        `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
        '--jq',
        '.[] | {id, path, line, body, user: {login: .user.login}, created_at}',
      ],
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
    );

    if (!stdout.trim()) return [];
    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  }

  /**
   * Fetch PR reviews via gh API
   */
  private async fetchReviews(owner: string, repo: string, prNumber: number): Promise<PRReview[]> {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        `repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
        '--jq',
        '[.[] | {id, state, user: {login: .user.login}, submitted_at}]',
      ],
      { timeout: 15000 }
    );

    return JSON.parse(stdout || '[]');
  }

  /**
   * Handle post-push: check unresolved threads, auto-reply to addressed ones,
   * and keep unresolved-thread state fresh for the next poll cycle.
   *
   * @param allComments - Pre-fetched comments (to avoid N+1 API calls)
   */
  private async handlePostPush(
    session: PollSession,
    changedFiles: string[],
    allComments: PRComment[]
  ): Promise<void> {
    const changedFileSet = new Set(changedFiles);

    // Fetch unresolved threads via GraphQL
    const threads = await this.fetchUnresolvedThreads(
      session.owner,
      session.repo,
      session.prNumber
    );

    const addressed: ReviewThread[] = [];
    const stillUnresolved: ReviewThread[] = [];

    for (const thread of threads) {
      if (thread.isResolved) continue;

      // Check if any comment in the thread has our "Fixed" reply already
      const hasFixedReply = thread.comments.some((c) => c.body.startsWith(FIXED_REPLY_PREFIX));
      if (hasFixedReply) continue;

      // Check if the file was changed in the latest push
      const threadPath = thread.comments[0]?.path;
      if (threadPath && changedFileSet.has(threadPath)) {
        addressed.push(thread);
      } else {
        stillUnresolved.push(thread);
      }
    }

    // Auto-reply to addressed threads
    if (addressed.length > 0) {
      const shortSha = session.lastHeadSha?.substring(0, 7) ?? 'latest';

      // Use pre-fetched comments (passed as parameter to avoid N+1 API calls)

      for (const thread of addressed) {
        try {
          await this.replyToThread(
            session.owner,
            session.repo,
            session.prNumber,
            thread,
            `${FIXED_REPLY_PREFIX} ${shortSha}`,
            allComments
          );

          // Mark all comments in this thread as addressed (by matching path/line)
          const threadPath = thread.comments[0]?.path;
          const threadLine = thread.comments[0]?.line;
          if (threadPath) {
            for (const comment of allComments) {
              if (comment.path === threadPath && (!threadLine || comment.line === threadLine)) {
                session.addressedCommentIds.add(comment.id);
              }
            }
          }
        } catch (err) {
          this.logger.error(`[PRPoller] Failed to reply to thread:`, err);
        }
      }
      this.logger.info(
        `[PRPoller] Auto-replied to ${addressed.length} addressed threads for ${session.owner}/${session.repo}#${session.prNumber}`
      );
    }

    if (stillUnresolved.length > 0) {
      this.logger.info(
        `[PRPoller] Detected ${stillUnresolved.length} still-unresolved threads in push context for ${session.owner}/${session.repo}#${session.prNumber}`
      );
    }
  }

  /**
   * Format unresolved threads with details grouped by file.
   */
  private formatUnresolvedThreads(
    sessionKey: string,
    threads: ReviewThread[],
    totalThreads?: number
  ): string {
    const resolvedCount = totalThreads !== undefined ? totalThreads - threads.length : 0;
    const header = `⚠️ PR ${sessionKey} — ${threads.length} unresolved thread(s)${totalThreads !== undefined ? ` (${resolvedCount} resolved)` : ''}`;

    // Group by file
    const byFile = new Map<string, ReviewThread[]>();
    for (const t of threads) {
      const file = t.comments[0]?.path || '(general)';
      const list = byFile.get(file) || [];
      list.push(t);
      byFile.set(file, list);
    }

    const lines: string[] = [header, ''];
    for (const [file, fileThreads] of byFile) {
      lines.push(`**${file}**`);
      for (const t of fileThreads) {
        const first = t.comments[0];
        if (!first) continue;
        const lineRef = first.line ? `:${first.line}` : '';
        const body = first.body.length > 200 ? first.body.substring(0, 200) + '…' : first.body;
        lines.push(`  • L${lineRef} ${body}`);
      }
      lines.push('');
    }

    if (byFile.size > 1) {
      lines.push(
        `💡 ${byFile.size} files — delegate in parallel when independent; keep coupled changes together (DELEGATE_BG)`
      );
    }

    return lines.join('\n');
  }

  /**
   * Fetch unresolved review threads via GitHub GraphQL API
   */
  private async fetchUnresolvedThreads(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewThread[]> {
    const query = `
      query($owner: String!, $repo: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            reviewThreads(last: 100) {
              totalCount
              nodes {
                id
                isResolved
                comments(first: 10) {
                  totalCount
                  nodes {
                    path
                    line
                    body
                    author { login }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `repo=${repo}`,
        '-F',
        `prNumber=${prNumber}`,
        '--jq',
        '.data.repository.pullRequest.reviewThreads | {totalCount, nodes}',
      ],
      { timeout: 20000 }
    );

    const result = JSON.parse(stdout || '{"totalCount":0,"nodes":[]}');
    const nodes = result.nodes || [];

    // Warn if GraphQL pagination caps are hit
    if (result.totalCount > 100) {
      this.logger.warn(
        `[PRPoller] Warning: PR has ${result.totalCount} review threads but only 100 fetched`
      );
    }

    return nodes.map((node: Record<string, unknown>) => ({
      id: node.id as string,
      isResolved: node.isResolved as boolean,
      comments: (
        ((node.comments as Record<string, unknown>)?.nodes as Record<string, unknown>[]) || []
      ).map((c: Record<string, unknown>) => ({
        path: c.path as string,
        line: c.line as number | null,
        body: c.body as string,
        author: ((c.author as Record<string, unknown>)?.login as string) ?? 'unknown',
      })),
    }));
  }

  /**
   * Reply to a review thread (uses the first comment's ID as in_reply_to)
   */
  private async replyToThread(
    owner: string,
    repo: string,
    prNumber: number,
    thread: ReviewThread,
    body: string,
    cachedComments?: PRComment[]
  ): Promise<void> {
    // GraphQL: addPullRequestReviewComment is complex.
    // Simpler: use REST API to reply to the thread's first comment.
    // We need the REST comment ID, but we have GraphQL ID.
    // Fetch comments and match by path+body to find the REST ID.
    const comments = cachedComments ?? (await this.fetchComments(owner, repo, prNumber));
    const firstThreadComment = thread.comments[0];
    if (!firstThreadComment) return;

    const matching = comments.find(
      (c) => c.path === firstThreadComment.path && c.body === firstThreadComment.body
    );
    if (!matching) return;

    await execFileAsync(
      'gh',
      [
        'api',
        `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
        '-X',
        'POST',
        '-f',
        `body=${body}`,
        '-F',
        `in_reply_to=${matching.id}`,
      ],
      { timeout: 15000 }
    );
  }

  /**
   * Fetch HEAD commit SHA of the PR branch
   */
  private async fetchHeadSha(owner: string, repo: string, prNumber: number): Promise<string> {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${owner}/${repo}/pulls/${prNumber}`, '--jq', '.head.sha'],
      { timeout: 10000 }
    );

    return stdout.trim();
  }

  /**
   * Fetch list of files changed between two commits
   */
  private async fetchChangedFiles(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string
  ): Promise<string[]> {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        `repos/${owner}/${repo}/compare/${baseSha}...${headSha}`,
        '--jq',
        '[.files[].filename]',
      ],
      { timeout: 15000 }
    );

    return JSON.parse(stdout || '[]');
  }

  /**
   * Fetch PR state (OPEN, MERGED, CLOSED)
   */
  private async fetchPRState(owner: string, repo: string, prNumber: number): Promise<string> {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        `repos/${owner}/${repo}/pulls/${prNumber}`,
        '--jq',
        '.state + (if .merged then "_MERGED" else "" end)',
      ],
      { timeout: 10000 }
    );

    const state = stdout.trim();
    if (state.includes('MERGED')) return 'MERGED';
    return state.toUpperCase(); // "open" → "OPEN", "closed" → "CLOSED"
  }

  private async prepareWorkspace(
    workspaceRoot: string,
    parsed: { owner: string; repo: string; prNumber: number }
  ): Promise<string> {
    const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const slug = `${sanitize(parsed.owner)}-${sanitize(parsed.repo)}-pr-${parsed.prNumber}`;
    const workspaceDir = join(workspaceRoot, 'pr-reviews', slug);
    await mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  private async ensureGhAuth(): Promise<void> {
    try {
      await execFileAsync('gh', ['auth', 'status', '-h', 'github.com'], { timeout: 10000 });
    } catch (err) {
      throw new Error(`GitHub CLI not authenticated. Run "gh auth login". ${String(err)}`);
    }
  }

  private async ensureRepo(workspaceDir: string, owner: string, repo: string): Promise<void> {
    const gitDir = join(workspaceDir, '.git');
    if (!existsSync(gitDir)) {
      await execFileAsync('gh', ['repo', 'clone', `${owner}/${repo}`, '.'], {
        timeout: 60000,
        cwd: workspaceDir,
      });
      return;
    }

    const remoteUrl = await this.getRemoteUrl(workspaceDir);
    if (!remoteUrl || !this.matchesRepo(remoteUrl, owner, repo)) {
      throw new Error(
        `Workspace repo mismatch. Expected ${owner}/${repo} but found ${remoteUrl || 'unknown'}`
      );
    }
  }

  private async getRemoteUrl(workspaceDir: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], {
        timeout: 10000,
        cwd: workspaceDir,
      });
      const url = stdout.trim();
      return url || null;
    } catch {
      return null;
    }
  }

  private matchesRepo(remoteUrl: string, owner: string, repo: string): boolean {
    const match = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (!match) return false;
    return match[1] === `${owner}/${repo}`;
  }

  private async withWorkspaceLock<T>(workspaceDir: string, task: () => Promise<T>): Promise<T> {
    const lockPath = join(workspaceDir, '.mama-pr-review.lock');
    const startedAt = Date.now();
    const timeoutMs = 30_000;
    const maxLockAgeMs = 2 * 60 * 1000;

    let acquired = false;
    while (!acquired) {
      try {
        await writeFile(
          lockPath,
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
          { flag: 'wx' }
        );
        acquired = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
        let isStale = true;
        try {
          const existing = await readFile(lockPath, 'utf8');
          const parsed = JSON.parse(existing) as { pid?: number; startedAt?: string };
          const lockPid = typeof parsed.pid === 'number' ? parsed.pid : null;
          const lockStarted = parsed.startedAt ? Date.parse(parsed.startedAt) : NaN;
          const lockAge = Number.isFinite(lockStarted) ? Date.now() - lockStarted : Infinity;

          if (lockPid) {
            try {
              process.kill(lockPid, 0);
              isStale = lockAge > maxLockAgeMs;
            } catch (pidErr) {
              isStale = (pidErr as NodeJS.ErrnoException).code === 'ESRCH';
            }
          }
        } catch {
          isStale = true;
        }

        if (isStale) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }

        if (Date.now() - startedAt > timeoutMs) {
          const existing = await readFile(lockPath, 'utf8').catch(() => '');
          throw new Error(`Workspace lock timed out. Lock info: ${existing || 'unknown'}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    try {
      return await task();
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }
  }

  /**
   * Parse GitHub PR URL into owner/repo/number
   */
  parsePRUrl(url: string): { owner: string; repo: string; prNumber: number } | null {
    // Match: https://github.com/owner/repo/pull/123 (with anchors to prevent partial matches)
    const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (!match) return null;

    return {
      owner: match[1],
      repo: match[2],
      prNumber: parseInt(match[3], 10),
    };
  }

  /**
   * Detect PR URLs in message text
   */
  static extractPRUrls(text: string): string[] {
    const pattern = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/g;
    return text.match(pattern) || [];
  }

  /**
   * Send message to Slack via callback
   */
  private async sendMessage(
    channelId: string,
    text: string,
    _batchItem?: PRPollerBatchItem
  ): Promise<void> {
    if (!this.messageSender) {
      this.logger.error('[PRPoller] No message sender configured');
      throw new Error('[PRPoller] No message sender configured');
    }

    // Discord has a 2000 char limit; split long messages
    const chunks = splitForDiscord(text);
    this.logger.info(`[PRPoller] sendMessage split into ${chunks.length} chunk(s)`);

    for (const chunk of chunks) {
      await this.messageSender(channelId, chunk);
    }
  }

  /**
   * Build a compact, single-line summary for orchestrator wake-up prompts.
   * Keep the text intentionally short to avoid PR wake-up context bloat.
   */
  private extractBatchSummary(text: string): string {
    const stripped = text
      .replace(/<@[^>]+>\s*/g, '')
      .replace(/\*\*/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    const maxLength = 320;
    return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}…` : stripped;
  }
}
