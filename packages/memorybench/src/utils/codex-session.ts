/**
 * Persistent Codex MCP session for memorybench.
 *
 * Uses the same MCP protocol as MAMA's CodexMCPProcess:
 *   1. spawn `codex mcp-server`
 *   2. MCP initialize
 *   3. tools/call "codex" (first message, gets threadId)
 *   4. tools/call "codex-reply" (subsequent messages, reuses threadId)
 *
 * Benefits over `codex exec`:
 *   - Single process for all questions (no cold start per question)
 *   - threadId-based session = prompt caching by Codex
 *   - Token usage tracking via _meta.usage
 */

import { spawn, type ChildProcess } from "child_process"
import { createInterface, type Interface } from "readline"
import { existsSync, mkdirSync, copyFileSync, chmodSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { logger } from "./logger"

export interface CodexSessionOptions {
  model: string
  systemPrompt?: string
  cwd?: string
  timeoutMs?: number
  sandbox?: "read-only" | "workspace-write"
  codexHome?: string
}

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | null
}

type SessionState = "dead" | "starting" | "ready" | "busy"

export class CodexSession {
  private process: ChildProcess | null = null
  private rl: Interface | null = null
  private state: SessionState = "dead"
  private threadId: string | null = null
  private requestId = 0
  private pendingRequests = new Map<number, PendingRequest>()
  private options: CodexSessionOptions
  private _messageCount = 0
  private _totalInputTokens = 0
  private _totalOutputTokens = 0
  private _totalCachedTokens = 0

  constructor(options: CodexSessionOptions) {
    this.options = options
  }

  async start(): Promise<void> {
    if (this.state !== "dead") return

    this.state = "starting"

    // Ensure codex home with auth
    const codexHome = this.options.codexHome || join(homedir(), ".mama", ".memorybench-codex")
    this.ensureCodexHome(codexHome)

    // Find codex command
    const command = process.env.CODEX_COMMAND || "codex"

    logger.info(`[CodexSession] Starting MCP server (model: ${this.options.model})`)

    this.process = spawn(command, ["mcp-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.options.cwd || "/tmp",
      env: { ...process.env, CODEX_HOME: codexHome },
    })

    this.rl = createInterface({ input: this.process.stdout!, crlfDelay: Infinity })
    this.rl.on("line", (line) => this.handleLine(line))
    this.process.stderr?.on("data", () => {}) // ignore
    this.process.on("close", (code) => this.handleClose(code))
    this.process.on("error", (err) => this.handleError(err))

    // Wait for spawn
    await new Promise((r) => setTimeout(r, 200))

    // MCP initialize
    const initTimeout = 30_000
    try {
      await Promise.race([
        this.sendRequest("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "memorybench", version: "1.0.0" },
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("MCP init timeout")), initTimeout)
        ),
      ])
      this.state = "ready"
      logger.info("[CodexSession] Ready")
    } catch (e) {
      this.close()
      throw e
    }
  }

  async prompt(text: string): Promise<string> {
    if (this.state === "dead") await this.start()
    if (this.state === "busy") {
      // Wait for ready
      const start = Date.now()
      while (this.state === "busy" && Date.now() - start < 120_000) {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    if (this.state !== "ready") throw new Error(`Session not ready (state: ${this.state})`)

    this.state = "busy"
    this._messageCount++

    try {
      let result: { threadId: string; content: string; usage?: Record<string, number> }

      if (!this.threadId) {
        // First message: use "codex" tool
        const args: Record<string, unknown> = {
          prompt: text,
          model: this.options.model,
          sandbox: this.options.sandbox || "read-only",
        }
        if (this.options.systemPrompt) {
          args["developer-instructions"] = this.options.systemPrompt
        }
        result = await this.callTool("codex", args)
        this.threadId = result.threadId
      } else {
        // Subsequent: use "codex-reply"
        result = await this.callTool("codex-reply", {
          threadId: this.threadId,
          prompt: text,
        })
      }

      // Track tokens
      if (result.usage) {
        this._totalInputTokens += result.usage.inputTokens || 0
        this._totalOutputTokens += result.usage.outputTokens || 0
        this._totalCachedTokens += result.usage.cachedTokens || 0
      }

      this.state = "ready"
      return result.content
    } catch (e) {
      this.state = "ready"
      throw e
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ threadId: string; content: string; usage?: Record<string, number> }> {
    const response = (await this.sendRequest("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>
      structuredContent?: { threadId?: string; content?: string }
      _meta?: { usage?: Record<string, number> }
    }

    const usage = response._meta?.usage

    // Prefer structuredContent
    if (response.structuredContent?.threadId) {
      return {
        threadId: response.structuredContent.threadId,
        content: response.structuredContent.content || "",
        usage,
      }
    }

    // Fallback: parse from content array
    if (response.content && Array.isArray(response.content)) {
      const textContent = response.content.find((c) => c.type === "text")
      if (textContent?.text) {
        try {
          const parsed = JSON.parse(textContent.text) as { threadId?: string; content?: string }
          return {
            threadId: parsed.threadId || this.threadId || "",
            content: parsed.content || textContent.text,
            usage,
          }
        } catch {
          return { threadId: this.threadId || "", content: textContent.text, usage }
        }
      }
    }

    return { threadId: this.threadId || "", content: "", usage }
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.process?.stdin) throw new Error("Process not running")

    const id = ++this.requestId
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params }
    const timeoutMs = this.options.timeoutMs ?? 180_000

    return new Promise((resolve, reject) => {
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pendingRequests.delete(id)
              reject(new Error(`Request timeout: ${method} (${timeoutMs}ms)`))
            }, timeoutMs)
          : null

      this.pendingRequests.set(id, { resolve, reject, timeout })
      this.process!.stdin!.write(JSON.stringify(request) + "\n")
    })
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    try {
      const msg = JSON.parse(line) as JsonRpcResponse
      if ("id" in msg && msg.id !== undefined) {
        const pending = this.pendingRequests.get(msg.id)
        if (pending) {
          if (pending.timeout) clearTimeout(pending.timeout)
          this.pendingRequests.delete(msg.id)
          if (msg.error) {
            pending.reject(new Error(msg.error.message))
          } else {
            pending.resolve(msg.result)
          }
        }
      }
      // Ignore notifications (codex/event) for simplicity
    } catch {}
  }

  private handleClose(code: number | null): void {
    logger.info(`[CodexSession] Process closed (code: ${code})`)
    this.state = "dead"
    for (const [id, pending] of this.pendingRequests) {
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.reject(new Error(`Process exited with code ${code}`))
    }
    this.pendingRequests.clear()
  }

  private handleError(err: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.reject(err)
    }
    this.pendingRequests.clear()
  }

  private ensureCodexHome(codexHome: string): void {
    if (!existsSync(codexHome)) {
      mkdirSync(codexHome, { recursive: true, mode: 0o700 })
    }
    chmodSync(codexHome, 0o700)

    const internalAuth = join(codexHome, "auth.json")
    const candidates = [
      join(homedir(), ".codex", "auth.json"),
      join(homedir(), ".mama", ".codex", "auth.json"),
    ]
    const source = candidates.find((c) => existsSync(c))
    if (!source) throw new Error("Codex auth not found. Run `codex login` first.")
    copyFileSync(source, internalAuth)
    chmodSync(internalAuth, 0o600)
  }

  close(): void {
    if (this.process) {
      this.process.stdin?.end()
      this.process.kill("SIGTERM")
      this.process = null
    }
    this.rl?.close()
    this.state = "dead"
    logger.info(
      `[CodexSession] Closed after ${this._messageCount} messages ` +
        `(tokens: ${this._totalInputTokens} in, ${this._totalOutputTokens} out, ${this._totalCachedTokens} cached)`
    )
  }

  get messageCount(): number {
    return this._messageCount
  }

  get tokenStats(): { input: number; output: number; cached: number } {
    return {
      input: this._totalInputTokens,
      output: this._totalOutputTokens,
      cached: this._totalCachedTokens,
    }
  }

  get isAlive(): boolean {
    return this.state !== "dead"
  }
}
