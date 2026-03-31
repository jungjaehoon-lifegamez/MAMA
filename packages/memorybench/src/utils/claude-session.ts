/**
 * Lightweight persistent Claude CLI session for memorybench.
 *
 * Uses the same stream-json protocol as MAMA's PersistentClaudeProcess:
 *   Input:  {"type":"user","message":{"role":"user","content":"..."}}
 *   Output: {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *           {"type":"result","subtype":"success",...}
 */

import { spawn, type ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { logger } from "./logger"

export interface ClaudeSessionOptions {
  model: string
  systemPrompt?: string
  cwd?: string
  timeoutMs?: number
}

interface StreamMessage {
  type: "system" | "assistant" | "result" | "error"
  subtype?: string
  message?: {
    content: Array<{ type: string; text?: string }>
  }
  result?: string
  is_error?: boolean
  error?: string
  duration_ms?: number
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
  }
}

type SessionState = "starting" | "idle" | "busy" | "dead"

export class ClaudeSession {
  private process: ChildProcess | null = null
  private state: SessionState = "dead"
  private outputBuffer = ""
  private accumulatedText = ""
  private pendingResolve: ((text: string) => void) | null = null
  private pendingReject: ((err: Error) => void) | null = null
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null
  private options: ClaudeSessionOptions
  private _messageCount = 0

  constructor(options: ClaudeSessionOptions) {
    this.options = options
  }

  async start(): Promise<void> {
    if (this.state !== "dead") return

    this.state = "starting"
    const sessionId = randomUUID()

    // Ensure isolated workspace (same pattern as MAMA)
    const workspaceDir = join(homedir(), ".mama", ".memorybench-workspace")
    if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true })
    const gitDir = join(workspaceDir, ".git")
    if (!existsSync(gitDir)) mkdirSync(gitDir, { recursive: true })
    const headFile = join(gitDir, "HEAD")
    if (!existsSync(headFile)) writeFileSync(headFile, "ref: refs/heads/main\n")

    const emptyPluginDir = join(homedir(), ".mama", ".empty-plugins")
    if (!existsSync(emptyPluginDir)) mkdirSync(emptyPluginDir, { recursive: true })

    const args = [
      "--print",
      "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--session-id", sessionId,
      "--setting-sources", "project,local",
      "--plugin-dir", emptyPluginDir,
      "--tools", "",
      "--model", this.options.model,
    ]

    if (this.options.systemPrompt) {
      args.push("--system-prompt", this.options.systemPrompt)
    }

    logger.info(`[ClaudeSession] Starting persistent session (model: ${this.options.model})`)

    this.process = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workspaceDir,
      env: process.env,
    })

    this.process.stdout!.on("data", (chunk) => this.handleStdout(chunk))
    this.process.stderr!.on("data", () => {}) // ignore
    this.process.on("close", (code) => this.handleClose(code))
    this.process.on("error", (err) => this.handleError(err))

    // Wait for process to stabilize (same as MAMA's approach)
    await new Promise((r) => setTimeout(r, 500))

    if (this.process && !this.process.killed) {
      this.state = "idle"
      logger.info("[ClaudeSession] Ready")
    } else {
      this.state = "dead"
      throw new Error("Claude session failed to start")
    }
  }

  async prompt(text: string): Promise<string> {
    if (this.state === "dead") await this.start()
    if (this.state === "busy") throw new Error("Session is busy")
    if (this.state !== "idle") throw new Error(`Session not ready (state: ${this.state})`)

    this.state = "busy"
    this._messageCount++
    this.accumulatedText = ""

    const timeoutMs = this.options.timeoutMs ?? 120_000

    return new Promise<string>((resolve, reject) => {
      this.pendingResolve = resolve
      this.pendingReject = reject

      if (timeoutMs > 0) {
        this.timeoutHandle = setTimeout(() => {
          if (this.pendingReject) {
            this.pendingReject(new Error(`Prompt timed out after ${timeoutMs}ms`))
            this.clearPending()
            // Kill process on timeout (same as MAMA)
            this.process?.kill("SIGTERM")
            this.state = "dead"
          }
        }, timeoutMs)
      }

      const message = JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
      }) + "\n"

      this.process!.stdin!.write(message, (err) => {
        if (err && this.pendingReject) {
          this.pendingReject(err)
          this.clearPending()
        }
      })
    })
  }

  private handleStdout(chunk: Buffer): void {
    this.outputBuffer += chunk.toString()

    const lines = this.outputBuffer.split("\n")
    this.outputBuffer = lines.pop() || ""

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event: StreamMessage = JSON.parse(line)
        this.processEvent(event)
      } catch {}
    }

    // Try to parse buffer as complete JSON
    if (this.outputBuffer.trim()) {
      try {
        const event: StreamMessage = JSON.parse(this.outputBuffer)
        this.processEvent(event)
        this.outputBuffer = ""
      } catch {}
    }
  }

  private processEvent(event: StreamMessage): void {
    if (event.type === "system") return

    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) {
          this.accumulatedText += block.text
        }
      }
    }

    if (event.type === "result") {
      this.clearTimeout()
      if (event.is_error) {
        if (this.pendingReject) {
          this.pendingReject(new Error(event.error || "Unknown error"))
          this.clearPending()
        }
        this.state = "idle"
      } else {
        const text = this.accumulatedText.trim() || event.result || ""
        if (this.pendingResolve) {
          this.pendingResolve(text)
          this.clearPending()
        }
        this.state = "idle"
      }
    }

    if (event.type === "error") {
      this.clearTimeout()
      if (this.pendingReject) {
        this.pendingReject(new Error(event.error || "Unknown error"))
        this.clearPending()
      }
      this.state = "idle"
    }
  }

  private handleClose(code: number | null): void {
    logger.info(`[ClaudeSession] Process closed (code: ${code})`)
    this.state = "dead"
    if (this.pendingReject) {
      this.pendingReject(new Error(`Process exited with code ${code}`))
      this.clearPending()
    }
  }

  private handleError(err: Error): void {
    if (this.pendingReject) {
      this.pendingReject(err)
      this.clearPending()
    }
    if (this.state === "busy") this.state = "idle"
  }

  private clearPending(): void {
    this.pendingResolve = null
    this.pendingReject = null
    this.accumulatedText = ""
    this.clearTimeout()
  }

  private clearTimeout(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle)
      this.timeoutHandle = null
    }
  }

  close(): void {
    if (this.process) {
      this.process.stdin?.end()
      this.process.kill("SIGTERM")
      this.process = null
    }
    this.state = "dead"
    this.clearPending()
    logger.info(`[ClaudeSession] Closed after ${this._messageCount} messages`)
  }

  get messageCount(): number {
    return this._messageCount
  }

  get isAlive(): boolean {
    return this.state !== "dead"
  }
}
