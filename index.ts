/**
 * bash-env-exec – openclaw plugin
 *
 * Gateway exec replacement that sets BASH_ENV before spawning the shell.
 * Implements the same interface as the built-in exec tool (command, workdir,
 * env, yieldMs, background, timeout, pty) but bypasses openclaw's env
 * sanitisation layer so that BASH_ENV reaches the shell.
 *
 * Limitations vs the built-in exec:
 *   - No host= support (gateway / local only; sandbox, node not supported).
 *   - No elevated / approval support.
 *   - Background mode yields a "still running" response but the session is
 *     NOT tracked in openclaw's process registry, so the `process` tool
 *     (list / poll / log / write / kill) will not see it.
 *   - PTY support is best-effort via @lydell/node-pty; falls back to a pipe
 *     if the native module is unavailable.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Schema (mirrors bash-tools.exec-runtime.ts execSchema)
// ---------------------------------------------------------------------------

const execSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to execute" },
    workdir: { type: "string", description: "Working directory (defaults to cwd)" },
    env: { type: "object", additionalProperties: { type: "string" } },
    yieldMs: { type: "number", description: "Milliseconds to wait before backgrounding (default 10000)" },
    background: { type: "boolean", description: "Run in background immediately" },
    timeout: { type: "number", description: "Timeout in seconds (optional, kills process on expiry)" },
    pty: { type: "boolean", description: "Run in a pseudo-terminal (PTY) when available. Falls back to pipe on failure." },
    // Accepted for interface compatibility; ignored by this plugin.
    elevated: { type: "boolean" },
    host: { type: "string" },
    security: { type: "string" },
    ask: { type: "string" },
    node: { type: "string" },
  },
  required: ["command"],
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveShell(): string {
  const envShell = process.env.SHELL?.trim();
  if (!envShell) return "bash";
  const name = path.basename(envShell);
  // If the configured shell is fish, fall back to bash (same logic as openclaw).
  if (name === "fish") return "bash";
  return envShell;
}

function prepareEnv(params: {
  bashEnvFile: string;
  pathPrepend: string[];
  agentId?: string;
  userEnv?: Record<string, string>;
}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v;
  }

  // Prepend configured PATH entries.
  if (params.pathPrepend.length > 0) {
    const pathKey = Object.keys(base).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const existing = base[pathKey] ?? "";
    base[pathKey] = [...params.pathPrepend, ...existing.split(path.delimiter).filter(Boolean)]
      .join(path.delimiter);
  }

  // Merge caller-supplied env (validated by the LLM; we trust them here since
  // this is a local dev tool, not a security boundary).
  if (params.userEnv) {
    Object.assign(base, params.userEnv);
  }

  // BASH_ENV and agent identity are set last so they cannot be overridden by the caller.
  base["BASH_ENV"] = params.bashEnvFile;
  base["OPENCLAW_SHELL"] = "exec";
  if (params.agentId) {
    base["OPENCLAW_AGENT"] = params.agentId;
  }

  return base;
}

function sanitizeBinary(s: string): string {
  // Strip non-printable control characters except newline / tab / CR.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

interface PluginConfig {
  toolName?: string;
  bashEnvFile?: string;
  pathPrepend?: string[];
  defaultTimeoutSec?: number;
  defaultYieldMs?: number;
}

const plugin = {
  id: "bash-env-exec",
  name: "Bash Env Exec",

  register(api: OpenClawPluginApi) {
    console.error(`[bash-env-exec] register() called`);
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;
    const toolName = cfg.toolName ?? "shell";
    const bashEnvFile = cfg.bashEnvFile ?? ".bash_env";
    const pathPrepend = Array.isArray(cfg.pathPrepend) ? cfg.pathPrepend : [];
    const defaultTimeoutSec =
      typeof cfg.defaultTimeoutSec === "number" && cfg.defaultTimeoutSec >= 1
        ? cfg.defaultTimeoutSec
        : 1800;
    const defaultYieldMs =
      typeof cfg.defaultYieldMs === "number" && cfg.defaultYieldMs >= 10
        ? cfg.defaultYieldMs
        : 10_000;

    console.error(`[bash-env-exec] registering tool "${toolName}" (optional=true)`);
    api.registerTool(
      (ctx) => ({
        name: toolName,
        label: toolName,
        description: [
          `Run shell commands (pty available for TTY-required CLIs).`,
          `This is the exec tool — use it for ALL shell command execution.`,
          `BASH_ENV is set automatically before every command.`,
          `For long waits use yieldMs (e.g. yieldMs=30000) or background=true, then poll with the process tool.`,
        ].join(" "),
        parameters: execSchema,

        execute: async (_toolCallId, args, abortSignal, onUpdate) => {
          console.error(`[bash-env-exec] execute() called, toolCallId=${_toolCallId}, args=${JSON.stringify(args)}`);
          const params = args as {
            command: string;
            workdir?: string;
            env?: Record<string, string>;
            yieldMs?: number;
            background?: boolean;
            timeout?: number;
            pty?: boolean;
            elevated?: boolean;
            host?: string;
            security?: string;
            ask?: string;
            node?: string;
          };

          if (!params.command) {
            throw new Error("Provide a command to start.");
          }

          const warnings: string[] = [];

          // Warn about unsupported params.
          if (params.host && params.host !== "gateway") {
            warnings.push(
              `Warning: host=${params.host} is not supported by bash-env-exec; running on gateway.`,
            );
          }
          if (params.elevated) {
            warnings.push("Warning: elevated mode is not supported by bash-env-exec; ignoring.");
          }
          if (params.node) {
            warnings.push(
              "Warning: node= is not supported by bash-env-exec; running on gateway.",
            );
          }

          // Resolve workdir.
          const rawWorkdir = params.workdir?.trim() || process.cwd();
          const workdir = path.isAbsolute(rawWorkdir)
            ? rawWorkdir
            : path.resolve(process.cwd(), rawWorkdir);

          // Build env with BASH_ENV and agent identity injected.
          const env = prepareEnv({ bashEnvFile, pathPrepend, agentId: ctx.agentId, userEnv: params.env });

          // Shell binary.
          const shell = resolveShell();
          console.error(`[bash-env-exec] shell=${shell}, workdir=${workdir}, command=${params.command}`);

          // Timeout.
          const timeoutMs =
            typeof params.timeout === "number" && params.timeout > 0
              ? Math.floor(params.timeout * 1000)
              : Math.floor(defaultTimeoutSec * 1000);

          // Yield window for background mode.
          const backgroundRequested = params.background === true;
          const yieldWindow = backgroundRequested
            ? 0
            : typeof params.yieldMs === "number"
              ? Math.max(10, params.yieldMs)
              : defaultYieldMs;

          const getWarningText = () =>
            warnings.length > 0 ? warnings.join("\n") + "\n\n" : "";

          // Try PTY if requested.
          let ptyModule: typeof import("@lydell/node-pty") | null = null;
          if (params.pty) {
            try {
              ptyModule = (await import("@lydell/node-pty")) as typeof import("@lydell/node-pty");
            } catch {
              warnings.push("Warning: PTY requested but @lydell/node-pty is unavailable; running without PTY.");
            }
          }

          return new Promise((resolve, reject) => {
            let output = "";
            let settled = false;
            let yielded = false;
            let timeoutHandle: NodeJS.Timeout | null = null;
            let yieldHandle: NodeJS.Timeout | null = null;

            const emitUpdate = () => {
              if (onUpdate) {
                onUpdate({
                  content: [{ type: "text", text: getWarningText() + output }],
                  details: { status: "running", cwd: workdir },
                });
              }
            };

            const finish = (
              exitCode: number | null,
              sigName: NodeJS.Signals | string | null,
              timedOut = false,
            ) => {
              if (settled) return;
              settled = true;
              if (timeoutHandle) clearTimeout(timeoutHandle);
              if (yieldHandle) clearTimeout(yieldHandle);

              const text = output.trim() || "(no output)";
              const warnText = getWarningText();

              if (yielded) {
                // Already resolved with "still running"; nothing more to do.
                return;
              }

              if (timedOut) {
                reject(
                  new Error(
                    `${text}\n\nCommand timed out after ${params.timeout ?? defaultTimeoutSec} seconds.`,
                  ),
                );
                return;
              }

              if (sigName && !exitCode) {
                reject(new Error(`${text}\n\nCommand aborted by signal ${sigName}`));
                return;
              }

              if (exitCode === 126) {
                reject(new Error(`${text}\n\nCommand not executable (permission denied)`));
                return;
              }
              if (exitCode === 127) {
                reject(new Error(`${text}\n\nCommand not found`));
                return;
              }

              const exitMsg = exitCode && exitCode !== 0 ? `\n\n(Command exited with code ${exitCode})` : "";
              resolve({
                content: [{ type: "text", text: warnText + text + exitMsg }],
                details: {
                  status: "completed",
                  exitCode: exitCode ?? 0,
                  cwd: workdir,
                  aggregated: output.trim(),
                },
              });
            };

            const killProc = (proc: { kill: (sig?: string) => void }) => {
              try {
                proc.kill("SIGTERM");
              } catch {
                // ignore
              }
              setTimeout(() => {
                try {
                  proc.kill("SIGKILL");
                } catch {
                  // ignore
                }
              }, 5000);
            };

            // ---------------------------------------------------------------
            // Spawn
            // ---------------------------------------------------------------

            if (ptyModule) {
              // PTY path
              const pty = ptyModule.spawn(shell, ["-c", params.command], {
                name: "xterm-256color",
                cols: 220,
                rows: 50,
                cwd: workdir,
                env,
              });

              pty.onData((data) => {
                const chunk = sanitizeBinary(data);
                output += chunk;
                emitUpdate();
              });

              pty.onExit(({ exitCode, signal }) => {
                finish(exitCode ?? null, signal?.toString() ?? null);
              });

              // Yield / background
              yieldHandle = setTimeout(() => {
                if (settled) return;
                yielded = true;
                resolve({
                  content: [
                    {
                      type: "text",
                      text: `${getWarningText()}Command still running (PTY). Output so far:\n${output.trim() || "(no output yet)"}`,
                    },
                  ],
                  details: { status: "running", cwd: workdir },
                });
              }, yieldWindow);

              // Timeout
              timeoutHandle = setTimeout(() => {
                killProc(pty);
                finish(null, null, true);
              }, timeoutMs);

              // Abort
              const onAbort = () => {
                if (!settled && !yielded) killProc(pty);
              };
              if (abortSignal?.aborted) {
                onAbort();
              } else {
                abortSignal?.addEventListener("abort", onAbort, { once: true });
              }
            } else {
              // Pipe path
              console.error(`[bash-env-exec] spawning pipe: ${shell} -c "${params.command}"`);
              const proc = spawn(shell, ["-c", params.command], {
                cwd: workdir,
                env,
                stdio: ["ignore", "pipe", "pipe"],
              });

              proc.stdout?.on("data", (chunk: Buffer) => {
                output += sanitizeBinary(chunk.toString());
                emitUpdate();
              });

              proc.stderr?.on("data", (chunk: Buffer) => {
                output += sanitizeBinary(chunk.toString());
                emitUpdate();
              });

              proc.on("close", (code, sig) => {
                console.error(`[bash-env-exec] proc closed, code=${code}, sig=${sig}, output=${JSON.stringify(output.slice(0, 200))}`);
                finish(code, sig);
              });

              proc.on("error", (err) => {
                console.error(`[bash-env-exec] proc error: ${err.message}`);
                if (!settled && !yielded) {
                  settled = true;
                  if (timeoutHandle) clearTimeout(timeoutHandle);
                  if (yieldHandle) clearTimeout(yieldHandle);
                  reject(err);
                }
              });

              // Yield / background
              yieldHandle = setTimeout(() => {
                if (settled) return;
                yielded = true;
                resolve({
                  content: [
                    {
                      type: "text",
                      text: `${getWarningText()}Command still running (pid ${proc.pid ?? "n/a"}). Output so far:\n${output.trim() || "(no output yet)"}`,
                    },
                  ],
                  details: { status: "running", cwd: workdir },
                });
              }, yieldWindow);

              // Timeout
              timeoutHandle = setTimeout(() => {
                killProc(proc);
                finish(null, null, true);
              }, timeoutMs);

              // Abort
              const onAbort = () => {
                if (!settled && !yielded) killProc(proc);
              };
              if (abortSignal?.aborted) {
                onAbort();
              } else {
                abortSignal?.addEventListener("abort", onAbort, { once: true });
              }
            }
          });
        },
      }),
      { optional: true },
    );
  },
};

export default plugin;
