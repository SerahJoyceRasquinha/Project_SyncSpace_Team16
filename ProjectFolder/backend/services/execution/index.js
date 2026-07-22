import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { LANGUAGES, LANGUAGE_IDS } from './languages.js';
import { runProcess } from './runner.js';

/**
 * The execution service. Completely independent of the collaboration server:
 * it imports nothing from socketService / workspaceStore and exposes exactly
 * one function, executeCode(). The route layer decides who may call it; this
 * layer only knows how to run code safely.
 *
 * Pipeline per request:
 *   temp dir -> write source -> [compile] -> run (with stdin) -> cleanup
 *
 * A small FIFO queue caps concurrent executions so a burst of Run clicks
 * cannot fork-bomb the host; queued requests report their wait honestly.
 */

const COMPILE_TIMEOUT_MS = Number(process.env.EXEC_COMPILE_TIMEOUT_MS) || 15000;
const RUN_TIMEOUT_MS = Number(process.env.EXEC_RUN_TIMEOUT_MS) || 5000;
const MAX_CONCURRENT = Number(process.env.EXEC_MAX_CONCURRENT) || 2;
const MAX_CODE_BYTES = 256 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;

// ------------------------------------------------------------------ queue
let running = 0;
const waiting = [];

function acquireSlot() {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

// --------------------------------------------------------------- pipeline
/**
 * On POSIX the sandbox wraps commands in a shell, so a missing binary is not an
 * ENOENT from spawn — it is the shell exiting 127 with "not found" on stderr.
 * Both spellings mean the same thing: the toolchain is not installed.
 */
const toolchainMissing = (res) =>
  res.exitCode === 127 && /not found|command not found/i.test(res.stderr || '');

const missingToolchainMessage = (lang) =>
  `The ${lang.label} toolchain (${lang.toolcheck}) is not installed on the server, ` +
  `so this language cannot run here yet. Ask the workspace host to install it.`;

/**
 * Execute one snippet.
 * Always RESOLVES with a result object — errors become structured fields, so
 * the route never has to guess which failures are the user's code vs ours:
 *
 * {
 *   ok, phase: 'run' | 'compile' | 'setup',
 *   stdout, stderr, compileOutput,
 *   exitCode, timedOut, truncated, durationMs, language
 * }
 */
export async function executeCode({ language, code, stdin = '' }) {
  const lang = LANGUAGES[language];
  if (!lang) {
    return {
      ok: false, phase: 'setup', language,
      stderr: `Unknown language "${language}". Supported: ${LANGUAGE_IDS.join(', ')}.`
    };
  }
  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, phase: 'setup', language, stderr: 'There is no code to run.' };
  }
  if (Buffer.byteLength(code) > MAX_CODE_BYTES) {
    return { ok: false, phase: 'setup', language, stderr: 'Program too large (max 256 KB).' };
  }
  const input = typeof stdin === 'string' ? stdin.slice(0, MAX_STDIN_BYTES) : '';

  await acquireSlot();
  let dir;
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'syncspace-run-'));
    const filename = lang.file(code);
    await writeFile(path.join(dir, filename), code, 'utf8');

    // ---- compile (only for compiled languages) -----------------------
    if (lang.compile) {
      const c = lang.compile(filename);
      let compiled;
      try {
        compiled = await runProcess(c.cmd, c.args, {
          cwd: dir,
          timeoutMs: COMPILE_TIMEOUT_MS,
          vmLimit: !lang.managed
        });
      } catch (err) {
        return err.code === 'ENOENT'
          ? { ok: false, phase: 'setup', language, stderr: missingToolchainMessage(lang) }
          : { ok: false, phase: 'setup', language, stderr: `Could not start the compiler: ${err.message}` };
      }
      if (toolchainMissing(compiled)) {
        return { ok: false, phase: 'setup', language, stderr: missingToolchainMessage(lang) };
      }
      if (compiled.timedOut) {
        return { ok: false, phase: 'compile', language, compileOutput: compiled.stderr, stderr: 'Compilation timed out.' };
      }
      if (compiled.exitCode !== 0) {
        return {
          ok: false, phase: 'compile', language,
          compileOutput: (compiled.stderr || compiled.stdout || '').trim(),
          stderr: 'Compilation failed.', durationMs: compiled.durationMs
        };
      }
    }

    // ---- run ----------------------------------------------------------
    const r = lang.run(lang.file(code));
    let result;
    try {
      result = await runProcess(r.cmd, r.args, {
        cwd: dir,
        stdin: input,
        timeoutMs: RUN_TIMEOUT_MS,
        vmLimit: !lang.managed
      });
    } catch (err) {
      return err.code === 'ENOENT'
        ? { ok: false, phase: 'setup', language, stderr: missingToolchainMessage(lang) }
        : { ok: false, phase: 'setup', language, stderr: `Could not start the program: ${err.message}` };
    }

    if (toolchainMissing(result)) {
      return { ok: false, phase: 'setup', language, stderr: missingToolchainMessage(lang) };
    }

    return {
      ok: !result.timedOut && result.exitCode === 0,
      phase: 'run',
      language,
      stdout: result.stdout,
      stderr: result.timedOut
        ? `${result.stderr}\n[terminated: exceeded the ${RUN_TIMEOUT_MS / 1000}s time limit]`.trim()
        : result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      durationMs: result.durationMs
    };
  } catch (err) {
    return { ok: false, phase: 'setup', language, stderr: `Execution failed: ${err.message}` };
  } finally {
    releaseSlot();
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** What the frontend needs to build its language dropdown. */
export function languageCatalog() {
  return LANGUAGE_IDS.map((id) => ({
    id,
    label: LANGUAGES[id].label,
    monaco: LANGUAGES[id].monaco
  }));
}
