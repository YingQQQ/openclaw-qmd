import { execFile, type ExecFileException } from "node:child_process";

export type QmdExecFile = (
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    timeout: number;
    maxBuffer: number;
    env: NodeJS.ProcessEnv;
  },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => unknown;

export type RunQmdInput = {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
};

type ExecOutput = {
  stdout: string;
  stderr: string;
};

type ExecError = NodeJS.ErrnoException & ExecOutput & {
  code?: string | number;
  signal?: NodeJS.Signals;
};

function execFilePromise(
  execFileImpl: QmdExecFile,
  command: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
): Promise<ExecOutput> {
  return new Promise((resolve, reject) => {
    execFileImpl(
      command,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 4,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as ExecError;
          err.stdout = stdout ?? "";
          err.stderr = stderr ?? "";
          reject(err);
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

function normalizeText(text: string): string {
  return text.trim() || "(no output)";
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function formatFailureMessage(input: RunQmdInput, err: ExecError): string {
  if (err.code === "ENOENT") {
    return (
      `qmd command not found: ${input.command}. ` +
      "Install qmd or set plugins.qmd.command to the correct executable path."
    );
  }

  let message = `qmd command failed: ${input.command} ${input.args.join(" ")}`;
  if (typeof err.code === "number") {
    message += ` (exit code ${err.code})`;
  } else if (err.signal) {
    message += ` (signal ${err.signal})`;
  }
  return message;
}

export function createQmdRunner(execFileImpl: QmdExecFile = execFile) {
  return async function runQmd(input: RunQmdInput) {
    try {
      const { stdout, stderr } = await execFilePromise(
        execFileImpl,
        input.command,
        input.args,
        input.cwd,
        input.timeoutMs,
      );

      const stdoutText = normalizeText(stdout);
      const stderrText = stderr.trim();
      const parsed = parseJson(stdout);

      return {
        content: [
          {
            type: "text" as const,
            text: stderrText ? `${stdoutText}\n\nstderr:\n${stderrText}` : stdoutText,
          },
        ],
        details: parsed ?? { stdout: stdoutText, stderr: stderrText || undefined },
      };
    } catch (error) {
      const err = error as ExecError;
      const message = formatFailureMessage(input, err);
      const details = [
        err.stdout?.trim() ? `stdout:\n${err.stdout.trim()}` : "",
        err.stderr?.trim() ? `stderr:\n${err.stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: details ? `${message}\n\n${details}` : message,
          },
        ],
        isError: true,
        details: {
          command: input.command,
          args: input.args,
          stdout: err.stdout?.trim() || undefined,
          stderr: err.stderr?.trim() || undefined,
          code: err.code,
          signal: err.signal,
        },
      };
    }
  };
}

export const runQmd = createQmdRunner();
