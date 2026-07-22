import { spawn } from 'child_process';
import { existsSync } from 'fs';

/**
 * The one place a child process is ever spawned. Every execution — compile or
 * run — goes through runProcess() and gets the same containment:
 *
 *   - hard wall-clock timeout (SIGKILL, not a polite SIGTERM)
 *   - stdout/stderr each capped at MAX_OUTPUT bytes (a print-loop cannot
 *     flood the server's memory; the stream keeps draining but stops storing)
 *   - a minimal environment (no inherited secrets from the server's env)
 *   - cwd pinned to a throwaway temp dir owned by this run
 *   - on POSIX, ulimit caps: virtual memory, CPU seconds, processes, file size
 *     (the classic sh -c 'ulimit ...; exec "$@"' trick keeps args unescaped)
 *
 * On Windows dev machines the ulimit layer is skipped — the timeout and output
 * caps still apply, and the per-runtime flags (-Xmx / --max-old-space-size)
 * still limit the managed runtimes. For real multi-tenant deployments the
 * README recommends wrapping this runner in a container; the interface here
 * stays identical either way, which is the point of isolating it in one file.
 */

export const MAX_OUTPUT = 64 * 1024; // per stream

const POSIX = process.platform !== 'win32';
// bash supports every ulimit flag we want; dash (Debian/Ubuntu /bin/sh) does
// not know -u, so when bash is missing we keep only the universally safe caps.
const BASH = POSIX && existsSync('/bin/bash');

const SAFE_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.TMPDIR || '/tmp',
  LANG: process.env.LANG || 'C.UTF-8'
};

/**
 * Wrap a command in POSIX resource limits (no-op on Windows).
 *
 * vmLimit is skipped for MANAGED runtimes (Node/JVM): V8 and the JVM reserve
 * gigabytes of virtual ADDRESS SPACE up front (code ranges, compressed-oops
 * heaps) even when actual memory use is tiny, so an address-space cap kills
 * them on startup. Their real memory is capped by their own flags instead
 * (--max-old-space-size / -Xmx), which languages.js always passes.
 */
function withLimits(cmd, args, { memoryKb, cpuSeconds, vmLimit }) {
  if (!POSIX) return { cmd, args };
  const caps = [
    `ulimit -t ${cpuSeconds}`, // CPU seconds
    'ulimit -f 10240'          // files it may write: 10 MB
  ];
  if (vmLimit) caps.push(`ulimit -v ${memoryKb}`); // virtual memory (native code)
  if (BASH) caps.push('ulimit -u 64');             // processes (fork bombs)
  const shell = BASH ? '/bin/bash' : '/bin/sh';
  // '"$@"' expansion passes the original argv through untouched — no quoting bugs
  return { cmd: shell, args: ['-c', `${caps.join('; ')}; exec "$@"`, 'sh', cmd, ...args] };
}

/**
 * Run one process to completion.
 * Resolves with { stdout, stderr, exitCode, signal, timedOut, durationMs }.
 * Rejects only if the binary cannot be started at all (missing toolchain).
 */
export function runProcess(cmd, args, {
  cwd,
  stdin = '',
  timeoutMs = 5000,
  memoryKb = 512 * 1024, // 512 MB virtual (native code); managed runtimes cap their own heap
  cpuSeconds = 10,
  vmLimit = true
} = {}) {
  return new Promise((resolve, reject) => {
    const wrapped = withLimits(cmd, args, { memoryKb, cpuSeconds, vmLimit });
    const started = process.hrtime.bigint();

    let child;
    try {
      child = spawn(wrapped.cmd, wrapped.args, {
        cwd,
        env: SAFE_ENV,
        windowsHide: true
      });
    } catch (err) {
      return reject(err);
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const collect = (buf, current) =>
      current.length >= MAX_OUTPUT ? current : current + buf.toString('utf8').slice(0, MAX_OUTPUT - current.length);

    child.stdout.on('data', (b) => { stdout = collect(b, stdout); });
    child.stderr.on('data', (b) => { stderr = collect(b, stderr); });

    child.on('error', (err) => {
      // spawn failed (ENOENT etc.) — surfaces as "toolchain missing" upstream
      clearTimeout(timer);
      if (!settled) { settled = true; reject(err); }
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal,
        timedOut,
        durationMs: Math.round(durationMs * 10) / 10,
        truncated: stdout.length >= MAX_OUTPUT || stderr.length >= MAX_OUTPUT
      });
    });

    // feed stdin then close it, so programs reading EOF terminate normally
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
    child.stdin.on('error', () => {}); // program may exit before reading stdin
  });
}
