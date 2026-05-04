/**
 * loopi — pi.dev RPC Client
 *
 * Spawns `pi --mode rpc --no-session` and communicates via JSON-RPC
 * over stdin/stdout. Used by the pipeline runner to call pi.dev agents
 * for scanning, analyzing, planning, executing, and improving.
 *
 * The client handles:
 *   - Cross-platform binary detection (pi.cmd on Windows)
 *   - Process lifecycle (spawn, health check, cleanup)
 *   - JSONL framing on stdout
 *   - Prompt → agent_end event correlation
 *   - Timeout handling
 *   - Error recovery
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";

// ─── Helpers ───

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text ?? "")
      .join("");
  }
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
  }
  return "";
}

// ─── RPC Client ───

export class RPCClient {
  private proc: ChildProcess | null = null;
  private stdoutBuffer = "";
  private decoder = new StringDecoder("utf8");
  private _spawned = false;
  private nextId = 1;

  /** Pending command response handlers (keyed by request id) */
  private pendingCommands = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (err: Error) => void }
  >();

  /** Agent-end promise — set before sending a prompt, resolved on agent_end */
  private agentEnd:
    | { resolve: (text: string) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }
    | null = null;

  /** Collected text from the current agent run (set on agent_end) */
  private collectedText = "";

  // (extension UI auto-dismiss handled inline in dispatchMessage)

  // ─── Spawn / Lifecycle ───

  /**
   * Check if the `pi` CLI is available on PATH.
   */
  static async isAvailable(): Promise<boolean> {
    const cmd = process.platform === "win32" ? "where pi" : "which pi";
    try {
      execSync(cmd, { stdio: "ignore", timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Spawn the pi RPC subprocess and wait for it to be ready.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async spawn(timeoutMs = 45_000): Promise<void> {
    if (this._spawned && this.proc) return;

    return new Promise<void>((resolve, reject) => {
      try {
        // On Windows, use cmd.exe /c pi.cmd (shell:true doesn't always work)
        // On Unix, use pi directly
        if (process.platform === "win32") {
          this.proc = spawn(
            "cmd.exe",
            ["/d", "/c", "pi.cmd", "--mode", "rpc", "--no-session"],
            {
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            }
          );
        } else {
          this.proc = spawn(
            "pi",
            ["--mode", "rpc", "--no-session"],
            {
              stdio: ["pipe", "pipe", "pipe"],
            }
          );
        }
      } catch (err) {
        reject(
          new Error(
            `Failed to spawn pi: ${err instanceof Error ? err.message : String(err)}. Is pi.dev installed?`
          )
        );
        return;
      }

      let resolved = false;

      // stdout — JSONL events
      this.proc.stdout!.on("data", (chunk: Buffer) => {
        this.stdoutBuffer += this.decoder.write(chunk);
        this.processStdoutBuffer();
      });

      // stderr — just log for debugging
      this.proc.stderr!.on("data", (_chunk: Buffer) => {
        // pi may log warnings here
      });

      // Process errors
      this.proc.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          reject(
            new Error(
              `pi process error: ${err.message}. Install pi.dev: npm install -g @mariozechner/pi-coding-agent`
            )
          );
        }
      });

      // Process exit — reject any in-flight requests
      this.proc.on("exit", (code, signal) => {
        // If not yet resolved, reject the spawn promise
        if (!resolved && code !== null) {
          resolved = true;
          reject(
            new Error(
              `pi exited with code ${code}${signal ? ` (${signal})` : ""}`
            )
          );
        }
        this._spawned = false;

        // Reject any in-flight agent prompt
        if (this.agentEnd) {
          clearTimeout(this.agentEnd.timeout);
          this.agentEnd.reject(
            new Error(`pi process exited unexpectedly (code ${code})`)
          );
          this.agentEnd = null;
        }

        // Reject all pending commands
        const pendingKeys = [...this.pendingCommands.keys()];
        for (const id of pendingKeys) {
          const handler = this.pendingCommands.get(id);
          if (handler) {
            handler.reject(
              new Error(`pi process exited unexpectedly (code ${code})`)
            );
            this.pendingCommands.delete(id);
          }
        }
      });

      // Health check — send get_state to verify the RPC mode is alive
      // Use a generous timeout since pi may emit extension init events first
      const doHealthCheck = () => {
        this.sendCommand("get_state", 25_000)
          .then(() => {
            if (!resolved) {
              resolved = true;
              this._spawned = true;
              resolve();
            }
          })
          .catch((err) => {
            if (!resolved) {
              // Retry once — pi might still be initializing
              this.sendCommand("get_state", 20_000)
                .then(() => {
                  if (!resolved) {
                    resolved = true;
                    this._spawned = true;
                    resolve();
                  }
                })
                .catch((err2) => {
                  if (!resolved) {
                    resolved = true;
                    reject(
                      new Error(
                        `pi RPC health check failed: ${err2.message}`
                      )
                    );
                  }
                });
            }
          });
      };

      // Small delay before health check to let pi initialize
      setTimeout(doHealthCheck, 500);

      // Startup timeout
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(
            new Error(
              `pi RPC did not respond within ${timeoutMs}ms. Is pi.dev installed and configured?`
            )
          );
        }
      }, timeoutMs);
    });
  }

  /**
   * Send a prompt to the pi agent and wait for the full response.
   *
   * The agent will use its tools (bash, read, edit, etc.) to process
   * the prompt and return structured output.
   *
   * @param message The user message to send to the agent
   * @param timeoutMs Maximum time to wait for agent completion (default: 5 min)
   * @returns The agent's response text
   */
  async prompt(message: string, timeoutMs = 300_000): Promise<string> {
    await this.spawn();

    // Reset collected text
    this.collectedText = "";

    const id = `req-${this.nextId++}`;

    return new Promise<string>((resolve, reject) => {
      // Set up agent_end handler
      const timeout = setTimeout(() => {
        if (this.agentEnd?.timeout === timeout) {
          this.agentEnd = null;
          reject(new Error(`Agent prompt timed out after ${timeoutMs / 1000}s`));
        }
      }, timeoutMs);

      this.agentEnd = {
        resolve: (text: string) => {
          clearTimeout(timeout);
          resolve(text);
        },
        reject: (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        },
        timeout,
      };

      // Send the prompt command
      const cmd = JSON.stringify({ id, type: "prompt", message }) + "\n";
      this.proc!.stdin!.write(cmd);
    });
  }

  /**
   * Send a follow-up message to be processed after the current agent finishes.
   */
  async followUp(message: string): Promise<void> {
    await this.spawn();
    await this.sendCommand("follow_up", 10_000, { message });
  }

  /**
   * Steer the currently running agent with an interrupt message.
   */
  async steer(message: string): Promise<void> {
    await this.spawn();
    await this.sendCommand("steer", 10_000, { message });
  }

  /**
   * Abort the current agent operation.
   */
  async abort(): Promise<void> {
    if (!this._spawned) return;
    try {
      await this.sendCommand("abort", 5_000);
    } catch {
      // best effort
    }
  }

  /**
   * Close the RPC connection and kill the subprocess.
   */
  close(): void {
    // Abort any in-flight prompt
    if (this.agentEnd) {
      clearTimeout(this.agentEnd.timeout);
      this.agentEnd.reject(new Error("RPC client closed"));
      this.agentEnd = null;
    }

    // Reject all pending commands
    const pendingKeys = [...this.pendingCommands.keys()];
    for (const id of pendingKeys) {
      const handler = this.pendingCommands.get(id);
      if (handler) {
        handler.reject(new Error("RPC client closed"));
        this.pendingCommands.delete(id);
      }
    }

    // Kill the process
    if (this.proc) {
      try {
        this.proc.stdin?.end();
        this.proc.kill("SIGTERM");
        // Force kill after 2s
        setTimeout(() => {
          try {
            this.proc?.kill("SIGKILL");
          } catch { /* ignore */ }
        }, 2_000).unref();
      } catch { /* ignore */ }
      this.proc = null;
    }

    this._spawned = false;
  }

  // ─── Internal: Command Sending ───

  /**
   * Send a command to the RPC process and wait for the response.
   */
  private sendCommand(
    type: string,
    timeoutMs = 10_000,
    extra: Record<string, unknown> = {}
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.proc || !this.proc.stdin) {
        reject(new Error("RPC client not spawned"));
        return;
      }

      const id = `req-${this.nextId++}`;
      const cmd = JSON.stringify({ id, type, ...extra }) + "\n";

      const timeout = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Command "${type}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingCommands.set(id, {
        resolve: (data: unknown) => {
          clearTimeout(timeout);
          resolve(data);
        },
        reject: (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.proc.stdin.write(cmd);
    });
  }

  // ─── Internal: Buffer Processing ───

  private processStdoutBuffer(): void {
    while (true) {
      const nlIdx = this.stdoutBuffer.indexOf("\n");
      if (nlIdx === -1) break;

      let line = this.stdoutBuffer.slice(0, nlIdx);
      this.stdoutBuffer = this.stdoutBuffer.slice(nlIdx + 1);

      // Strip carriage return (Windows compatibility)
      if (line.endsWith("\r")) line = line.slice(0, -1);

      // Skip empty lines
      if (line.trim() === "") continue;

      try {
        const msg = JSON.parse(line);
        this.dispatchMessage(msg);
      } catch {
        // Ignore malformed JSON lines
      }
    }
  }

  /**
   * Dispatch an incoming JSON message to the appropriate handler.
   */
  private dispatchMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;

    // ── Response to a command ──
    if (type === "response" && typeof msg.id === "string") {
      const handler = this.pendingCommands.get(msg.id);
      if (handler) {
        this.pendingCommands.delete(msg.id);
        if (msg.success) {
          handler.resolve(msg.data ?? null);
        } else {
          handler.reject(
            new Error(String(msg.error ?? "Command failed"))
          );
        }
      }
      return;
    }

    // ── Agent end — the agent finished processing ──
    if (type === "agent_end") {
      const messages = (msg.messages ?? []) as Array<Record<string, unknown>>;

      // Find the last assistant message and extract its text
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role === "assistant") {
          const text = extractTextFromContent(m.content);
          if (text) {
            this.collectedText = text;
            break;
          }
        }
      }

      // Resolve the agent-end promise
      if (this.agentEnd) {
        const ae = this.agentEnd;
        this.agentEnd = null;
        ae.resolve(this.collectedText);
      }
      return;
    }

    // ── Agent start (ignore) ──
    if (type === "agent_start") return;

    // ── Extension UI requests (auto-dismiss for now) ──
    if (type === "extension_ui_request") {
      const method = msg.method as string;
      const id = msg.id as string;
      const dialogMethods = ["select", "confirm", "input", "editor"];
      if (dialogMethods.includes(method)) {
        // Auto-dismiss dialog methods with reasonable defaults
        let response: Record<string, unknown>;
        if (method === "confirm") {
          response = { type: "extension_ui_response", id, confirmed: false };
        } else if (method === "select") {
          response = { type: "extension_ui_response", id, cancelled: true };
        } else {
          response = { type: "extension_ui_response", id, cancelled: true };
        }
        this.proc?.stdin?.write(JSON.stringify(response) + "\n");
      }
      return;
    }

    // ── Other events (ignore for now) ──
    // message_start, message_update, message_end,
    // turn_start, turn_end,
    // tool_execution_start, tool_execution_update, tool_execution_end,
    // compaction_start, compaction_end,
    // auto_retry_start, auto_retry_end,
    // queue_update, extension_error
  }

  /**
   * Whether the client has been successfully spawned.
   */
  get isSpawned(): boolean {
    return this._spawned && this.proc !== null && this.proc.exitCode === null;
  }
}
