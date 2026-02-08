/**
 * PR Review Poller
 *
 * Polls GitHub PR for new review comments and injects them into Slack channel.
 * Enables autonomous Sisyphus → DevBot → push → review → fix → push loop.
 *
 * Flow:
 * 1. Agent pushes and posts PR URL in channel
 * 2. Poller detects URL → starts polling `gh api` every 60s
 * 3. New review comments → formatted and sent to Slack as @Sisyphus mention
 * 4. Sisyphus analyzes severity → delegates fixes to @DevBot
 * 5. DevBot fixes → @Reviewer → approve or request changes
 * 6. Poller detects new comments or Approved → loop continues or ends
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Default polling interval (60 seconds) */
const POLL_INTERVAL_MS = 60 * 1000;

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

/**
 * Active polling session
 */
interface PollSession {
  owner: string;
  repo: string;
  prNumber: number;
  channelId: string;
  interval: ReturnType<typeof setInterval>;
  seenCommentIds: Set<number>;
  seenReviewIds: Set<number>;
  addressedCommentIds: Set<number>;
  seenUnresolvedThreadIds: Map<string, number>; // id → last reported timestamp
  lastHeadSha: string | null;
  startedAt: number;
}

/**
 * Callback for sending messages to Slack
 */
type MessageSender = (channelId: string, text: string) => Promise<void>;

/**
 * PR Review Poller
 *
 * Watches GitHub PRs for new review comments and routes them to agents.
 */
export class PRReviewPoller {
  private sessions: Map<string, PollSession> = new Map();
  private messageSender: MessageSender | null = null;
  private onBatchComplete: ((channelId: string) => Promise<void>) | null = null;
  private logger = console;

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
   * Set callback fired after all message chunks for a poll cycle are sent.
   * Used by Discord handler to trigger agent processing once (not per-chunk).
   */
  setOnBatchComplete(callback: (channelId: string) => Promise<void>): void {
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
      this.logger.log(`[PRPoller] Already polling ${sessionKey}`);
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

    const session: PollSession = {
      ...parsed,
      channelId,
      seenCommentIds,
      seenReviewIds,
      addressedCommentIds: new Set<number>(),
      seenUnresolvedThreadIds: new Map<string, number>(),
      lastHeadSha,
      startedAt: Date.now(),
      interval: setInterval(() => {
        this.poll(sessionKey).catch((err) => {
          this.logger.error(`[PRPoller] Poll error for ${sessionKey}:`, err);
        });
      }, POLL_INTERVAL_MS),
    };

    this.sessions.set(sessionKey, session);
    this.logger.log(
      `[PRPoller] Started polling ${sessionKey} (${seenCommentIds.size} existing comments, interval: ${POLL_INTERVAL_MS / 1000}s)`
    );

    // Run first poll immediately (then every POLL_INTERVAL_MS)
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
      clearInterval(session.interval);
      this.sessions.delete(sessionKey);
      this.logger.log(`[PRPoller] Stopped polling ${sessionKey}`);
    }
  }

  /**
   * Stop all polling sessions
   */
  stopAll(): void {
    for (const [key, session] of this.sessions) {
      clearInterval(session.interval);
      this.logger.log(`[PRPoller] Stopped polling ${key}`);
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
  getSessionDetails(): { owner: string; repo: string; prNumber: number; channelId: string }[] {
    return Array.from(this.sessions.values()).map((s) => ({
      owner: s.owner,
      repo: s.repo,
      prNumber: s.prNumber,
      channelId: s.channelId,
    }));
  }

  /**
   * Poll a single PR for new comments/reviews
   */
  private async poll(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    this.logger.log(
      `[PRPoller] Polling ${sessionKey} (seen: ${session.seenCommentIds.size} comments, ${session.seenReviewIds.size} reviews)`
    );

    // Auto-stop after max duration
    if (Date.now() - session.startedAt > MAX_POLL_DURATION_MS) {
      this.logger.log(`[PRPoller] Max duration reached for ${sessionKey}, stopping`);
      clearInterval(session.interval);
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
        this.logger.log(`[PRPoller] PR ${sessionKey} is ${prState}, stopping`);
        clearInterval(session.interval);
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
          try {
            await this.sendMessage(
              session.channelId,
              `✅ *PR Review* — ${sessionKey} **APPROVED** by ${review.user.login}. Polling stopped.`
            );
          } finally {
            clearInterval(session.interval);
            this.sessions.delete(sessionKey);
          }
          return;
        }

        if (review.state === 'CHANGES_REQUESTED') {
          await this.sendMessage(
            session.channelId,
            `🔴 *PR Review* — ${sessionKey} **CHANGES REQUESTED** by ${review.user.login}`
          );
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
        this.logger.log(
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
        await this.handlePostPush(session, sessionKey, changedFiles, allComments);
      } catch (err) {
        this.logger.error(`[PRPoller] Failed to handle post-push:`, err);
      }
    }

    // Standard flow: filter and send new comments
    try {
      const newComments = allComments.filter(
        (c) => !session.seenCommentIds.has(c.id) && !session.addressedCommentIds.has(c.id)
      );

      if (newComments.length === 0) {
        this.logger.log(
          `[PRPoller] No new comments for ${sessionKey} (total: ${allComments.length})`
        );
      } else {
        // Format and send new comments
        const formatted = this.formatComments(sessionKey, newComments);
        const mention = this.targetAgentUserId ? `<@${this.targetAgentUserId}> ` : '';
        await this.sendMessage(session.channelId, `${mention}${formatted}`);

        // Mark as seen only after successful send
        for (const c of newComments) {
          session.seenCommentIds.add(c.id);
        }

        this.logger.log(`[PRPoller] Sent ${newComments.length} new comments for ${sessionKey}`);
      }
    } catch (err) {
      this.logger.error(`[PRPoller] Failed to process comments:`, err);
    }

    // Check unresolved threads every cycle (not just after push)
    let hasNewData = false;
    try {
      const threads = await this.fetchUnresolvedThreads(
        session.owner,
        session.repo,
        session.prNumber
      );
      const allUnresolved = threads.filter((t) => !t.isResolved);
      const now = Date.now();
      const REMIND_INTERVAL_MS = 5 * 60 * 1000; // Re-remind after 5 minutes

      // New = never seen, or seen but still unresolved after remind interval
      const toReport = allUnresolved.filter((t) => {
        const lastReported = session.seenUnresolvedThreadIds.get(t.id);
        if (!lastReported) return true; // never reported
        return now - lastReported >= REMIND_INTERVAL_MS; // stale reminder
      });

      this.logger.log(
        `[PRPoller] Unresolved threads: ${allUnresolved.length} total, ${toReport.length} to report (of ${threads.length} fetched)`
      );

      if (toReport.length > 0) {
        hasNewData = true;
        // More accurate reminder detection: only if ALL threads are already seen
        const seenCount = toReport.filter((t) => session.seenUnresolvedThreadIds.has(t.id)).length;
        const isReminder = seenCount === toReport.length && seenCount > 0;
        const prefix = isReminder ? '🔔 *Reminder*: ' : '';
        const formatted = this.formatUnresolvedThreads(sessionKey, toReport);
        const mention = this.targetAgentUserId ? `<@${this.targetAgentUserId}> ` : '';
        await this.sendMessage(session.channelId, `${mention}${prefix}${formatted}`);

        for (const t of toReport) {
          session.seenUnresolvedThreadIds.set(t.id, now);
        }
        this.logger.log(
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
    if (hasNewData && this.onBatchComplete) {
      try {
        await this.onBatchComplete(session.channelId);
      } catch (err) {
        this.logger.error(`[PRPoller] onBatchComplete error:`, err);
      }
    }
  }

  /**
   * Format PR comments for Slack message
   */
  private formatComments(sessionKey: string, comments: PRComment[]): string {
    // Group by severity (detect from body)
    const critical: string[] = [];
    const major: string[] = [];
    const minor: string[] = [];
    const other: string[] = [];

    for (const c of comments) {
      const location = c.path ? `\`${c.path}${c.line ? `:${c.line}` : ''}\`` : '';
      const body = c.body.length > 200 ? c.body.substring(0, 200) + '...' : c.body;
      const entry = `${location} — ${body} _(${c.user.login})_`;

      // Detect severity from body content
      const bodyLower = c.body.toLowerCase();
      if (
        bodyLower.includes('critical') ||
        bodyLower.includes('bug') ||
        bodyLower.includes('security') ||
        bodyLower.includes('high')
      ) {
        critical.push(entry);
      } else if (
        bodyLower.includes('medium') ||
        bodyLower.includes('should') ||
        bodyLower.includes('major')
      ) {
        major.push(entry);
      } else if (
        bodyLower.includes('nit') ||
        bodyLower.includes('minor') ||
        bodyLower.includes('low') ||
        bodyLower.includes('suggestion')
      ) {
        minor.push(entry);
      } else {
        other.push(entry);
      }
    }

    let msg = `📝 *PR Review Comments* — ${sessionKey} (${comments.length} new comments)\n\n`;

    if (critical.length > 0) {
      msg += `*🔴 Critical/High:*\n${critical.map((e) => `• ${e}`).join('\n')}\n\n`;
    }
    if (major.length > 0) {
      msg += `*🟡 Medium:*\n${major.map((e) => `• ${e}`).join('\n')}\n\n`;
    }
    if (minor.length > 0) {
      msg += `*🔵 Minor/Nit:*\n${minor.map((e) => `• ${e}`).join('\n')}\n\n`;
    }
    if (other.length > 0) {
      msg += `*💬 Other:*\n${other.map((e) => `• ${e}`).join('\n')}\n\n`;
    }

    return msg;
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
        '.[] | {id, path, line, body: .body[0:1000], user: {login: .user.login}, created_at}',
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
   * and re-inject truly unresolved comments to Slack.
   *
   * @param allComments - Pre-fetched comments (to avoid N+1 API calls)
   */
  private async handlePostPush(
    session: PollSession,
    sessionKey: string,
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
      this.logger.log(
        `[PRPoller] Auto-replied to ${addressed.length} addressed threads for ${sessionKey}`
      );
    }

    // Report still-unresolved threads to Slack
    if (stillUnresolved.length > 0) {
      const formatted = this.formatUnresolvedThreads(sessionKey, stillUnresolved);
      const mention = this.targetAgentUserId ? `<@${this.targetAgentUserId}> ` : '';
      await this.sendMessage(session.channelId, `${mention}${formatted}`);
      this.logger.log(
        `[PRPoller] Sent ${stillUnresolved.length} unresolved threads for ${sessionKey}`
      );
    }
  }

  /**
   * Format unresolved threads for Slack message
   */
  private formatUnresolvedThreads(sessionKey: string, threads: ReviewThread[]): string {
    let msg = `⚠️ *Unresolved PR Comments* — ${sessionKey} (${threads.length} unresolved)\n\n`;
    msg += `These comments remain unresolved after the latest push:\n\n`;

    for (const thread of threads) {
      const first = thread.comments[0];
      if (!first) continue;
      const location = first.path ? `\`${first.path}${first.line ? `:${first.line}` : ''}\`` : '';
      const body = first.body.length > 150 ? first.body.substring(0, 150) + '...' : first.body;
      msg += `• ${location} — ${body} _(${first.author})_\n`;
    }

    // No hardcoded instructions — agent decides from persona
    return msg;
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

    // Debug: log isResolved distribution
    const unresolvedInRaw = nodes.filter(
      (n: Record<string, unknown>) => n.isResolved === false
    ).length;
    const resolvedInRaw = nodes.filter(
      (n: Record<string, unknown>) => n.isResolved === true
    ).length;
    this.logger.log(
      `[PRPoller] GraphQL raw: ${nodes.length} nodes, ${unresolvedInRaw} unresolved, ${resolvedInRaw} resolved, ${nodes.length - unresolvedInRaw - resolvedInRaw} other`
    );

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
  private async sendMessage(channelId: string, text: string): Promise<void> {
    if (!this.messageSender) {
      this.logger.error('[PRPoller] No message sender configured');
      return;
    }

    // Discord has a 4000 char limit; split long messages
    this.logger.log(`[PRPoller] sendMessage: ${text.length} chars`);
    if (text.length <= 1900) {
      await this.messageSender(channelId, text);
      return;
    }

    // Split by lines, keeping chunks under 1900 chars
    const lines = text.split('\n');
    let chunk = '';
    for (const line of lines) {
      if (chunk.length + line.length + 1 > 1900) {
        if (chunk) await this.messageSender(channelId, chunk);
        chunk = line;
      } else {
        chunk += (chunk ? '\n' : '') + line;
      }
    }
    if (chunk) await this.messageSender(channelId, chunk);
  }
}
