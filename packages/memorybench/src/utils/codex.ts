import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { homedir, tmpdir } from "os"
import { join } from "path"
import { spawn } from "child_process"

const DEFAULT_CODEX_HOME = join(homedir(), ".mama", ".memorybench-codex")
const DEFAULT_TIMEOUT_MS = 180_000

export interface CodexExecOptions {
  model: string
  cwd: string
  outputFile: string
  prompt: string
}

export interface CodexPromptOptions {
  model: string
  prompt: string
  cwd?: string
  timeoutMs?: number
  codexHome?: string
  command?: string
}

export function buildCodexExecArgs(options: CodexExecOptions): string[] {
  return [
    "exec",
    "-m",
    options.model,
    "-C",
    options.cwd,
    "-s",
    "read-only",
    "--color",
    "never",
    "-o",
    options.outputFile,
    options.prompt,
  ]
}

function ensureCodexHome(codexHome: string): void {
  if (!existsSync(codexHome)) {
    mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  }
  chmodSync(codexHome, 0o700)

  const internalAuthPath = join(codexHome, "auth.json")
  const authCandidates = [join(homedir(), ".codex", "auth.json"), join(homedir(), ".mama", ".codex", "auth.json")]
  const sourceAuthPath = authCandidates.find((candidate) => existsSync(candidate))
  if (!sourceAuthPath) {
    throw new Error("Codex auth not found. Run `codex login` first.")
  }

  copyFileSync(sourceAuthPath, internalAuthPath)
  chmodSync(internalAuthPath, 0o600)
}

export interface ClaudePromptOptions {
  model: string
  prompt: string
  cwd?: string
  timeoutMs?: number
  command?: string
}

export async function executeClaudePrompt(options: ClaudePromptOptions): Promise<string> {
  const command = options.command || process.env.CLAUDE_COMMAND || "claude"
  const args = [
    "-p",
    "--model", options.model,
    "--no-session-persistence",
    "--tools", "",
  ]

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })

    // Send prompt via stdin
    child.stdin.write(options.prompt)
    child.stdin.end()

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    child.on("close", (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`Claude CLI failed with code ${code}: ${stderr.trim() || "no stderr"}`))
        return
      }
      const response = stdout.trim()
      if (!response) {
        reject(new Error("Claude CLI returned an empty response"))
        return
      }
      resolve(response)
    })
  })
}

export async function executeCodexPrompt(options: CodexPromptOptions): Promise<string> {
  const command = options.command || process.env.CODEX_COMMAND || process.env.MAMA_CODEX_COMMAND || "codex"
  const codexHome = options.codexHome || DEFAULT_CODEX_HOME
  ensureCodexHome(codexHome)

  const tempDir = mkdtempSync(join(tmpdir(), "memorybench-codex-"))
  const outputFile = join(tempDir, "response.txt")
  const args = buildCodexExecArgs({
    model: options.model,
    cwd: options.cwd || process.cwd(),
    outputFile,
    prompt: options.prompt,
  })

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["ignore", "pipe", "pipe"],
      })

      let stderr = ""
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString()
      })

      const timeout = setTimeout(() => {
        child.kill("SIGKILL")
        reject(new Error(`Codex exec timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      child.on("error", (error) => {
        clearTimeout(timeout)
        reject(error)
      })

      child.on("close", (code) => {
        clearTimeout(timeout)
        if (code !== 0) {
          reject(new Error(`Codex exec failed with code ${code}: ${stderr.trim() || "no stderr"}`))
          return
        }
        resolve()
      })
    })

    const response = readFileSync(outputFile, "utf8").trim()
    if (!response) {
      throw new Error("Codex exec returned an empty response")
    }
    return response
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}
