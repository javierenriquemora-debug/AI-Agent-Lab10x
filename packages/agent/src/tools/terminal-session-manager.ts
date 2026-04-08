import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_CHARS = 12_000;

interface HostShell {
  executable: string;
  args: string[];
  kind: "powershell" | "bash";
}

interface TerminalSession {
  key: string;
  process: ChildProcessWithoutNullStreams;
  shell: HostShell;
  queue: Promise<void>;
}

export interface TerminalCommandResult {
  terminal: string;
  shell: HostShell["kind"];
  prompt: string;
  output: string;
  timedOut: boolean;
  truncated: boolean;
  exitCode: number | null;
}

const sessions = new Map<string, TerminalSession>();

function getHostShell(): HostShell {
  if (process.platform === "win32") {
    return {
      executable: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"],
      kind: "powershell",
    };
  }

  return {
    executable: "/bin/bash",
    args: ["-i"],
    kind: "bash",
  };
}

function buildSessionKey(userId: string, terminal: string): string {
  return `${userId}:${terminal}`;
}

function truncateOutput(output: string): { text: string; truncated: boolean } {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return { text: output.trim(), truncated: false };
  }

  return {
    text: `${output.slice(0, MAX_OUTPUT_CHARS).trim()}\n\n[output truncated]`,
    truncated: true,
  };
}

function createTerminalSession(key: string): TerminalSession {
  const shell = getHostShell();
  const child = spawn(shell.executable, shell.args, {
    stdio: "pipe",
    windowsHide: true,
    env: process.env,
  });

  const session: TerminalSession = {
    key,
    process: child,
    shell,
    queue: Promise.resolve(),
  };

  const cleanup = () => {
    sessions.delete(key);
  };

  child.once("exit", cleanup);
  child.once("error", cleanup);

  sessions.set(key, session);
  return session;
}

function getOrCreateTerminalSession(userId: string, terminal: string): TerminalSession {
  const key = buildSessionKey(userId, terminal);
  const existing = sessions.get(key);
  if (existing && !existing.process.killed && existing.process.exitCode === null) {
    return existing;
  }

  if (existing) {
    sessions.delete(key);
  }

  return createTerminalSession(key);
}

function disposeTerminalSession(session: TerminalSession): void {
  sessions.delete(session.key);
  if (!session.process.killed && session.process.exitCode === null) {
    session.process.kill();
  }
}

function buildWrappedCommand(
  shell: HostShell["kind"],
  prompt: string,
  marker: string
): string {
  if (shell === "powershell") {
    return [
      `$global:LASTEXITCODE = 0`,
      prompt,
      `$__cursorExitCode = if ($?) { 0 } elseif ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 }`,
      `Write-Output "${marker}:$__cursorExitCode"`,
      "",
    ].join("\r\n");
  }

  return `${prompt}\nprintf "\n${marker}:%s\n" "$?"\n`;
}

async function runCommandInSession(
  session: TerminalSession,
  terminal: string,
  prompt: string
): Promise<TerminalCommandResult> {
  const marker = `__CURSOR_CMD_END_${randomUUID()}__`;
  const wrappedCommand = buildWrappedCommand(session.shell.kind, prompt, marker);

  return new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let resolved = false;

    const finish = (result: TerminalCommandResult) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    const fail = (error: Error) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(error);
    };

    const handleStdout = (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");

      const markerIndex = stdoutBuffer.indexOf(marker);
      if (markerIndex === -1) {
        return;
      }

      const beforeMarker = stdoutBuffer.slice(0, markerIndex);
      const rest = stdoutBuffer.slice(markerIndex + marker.length + 1);
      const exitCodeMatch = rest.match(/^(-?\d+)/);
      const exitCode = exitCodeMatch ? Number(exitCodeMatch[1]) : null;

      const combined = [beforeMarker.trim(), stderrBuffer.trim()]
        .filter(Boolean)
        .join("\n");
      const { text, truncated } = truncateOutput(combined);

      finish({
        terminal,
        shell: session.shell.kind,
        prompt,
        output: text || "[no output]",
        timedOut: false,
        truncated,
        exitCode,
      });
    };

    const handleStderr = (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    };

    const handleExit = () => {
      fail(new Error(`Terminal session "${terminal}" ended unexpectedly.`));
    };

    const timeout = setTimeout(() => {
      const combined = [stdoutBuffer.trim(), stderrBuffer.trim()]
        .filter(Boolean)
        .join("\n");
      const { text, truncated } = truncateOutput(combined);
      disposeTerminalSession(session);
      finish({
        terminal,
        shell: session.shell.kind,
        prompt,
        output: text || "[command timed out with no output]",
        timedOut: true,
        truncated,
        exitCode: null,
      });
    }, COMMAND_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      session.process.stdout.off("data", handleStdout);
      session.process.stderr.off("data", handleStderr);
      session.process.off("exit", handleExit);
      session.process.off("error", handleExit);
    };

    session.process.stdout.on("data", handleStdout);
    session.process.stderr.on("data", handleStderr);
    session.process.once("exit", handleExit);
    session.process.once("error", handleExit);

    session.process.stdin.write(wrappedCommand, (error) => {
      if (error) {
        fail(error);
      }
    });
  });
}

export async function executeTerminalCommand(
  userId: string,
  terminal: string,
  prompt: string
): Promise<TerminalCommandResult> {
  const session = getOrCreateTerminalSession(userId, terminal);

  let result!: TerminalCommandResult;
  const task = session.queue
    .catch(() => undefined)
    .then(async () => {
      result = await runCommandInSession(session, terminal, prompt);
    });

  session.queue = task.finally(() => undefined);
  await task;
  return result;
}

