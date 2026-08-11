import { existsSync, statSync } from 'fs';
import path from 'path';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { runProcess } from '../runner.js';
import { STATUS, ProviderError, makeResult, signalReason } from '../result.js';

/**
 * Local adapter — OFF by default, and that is the whole point of this redesign.
 *
 * Running untrusted code on the machine that serves the app is the thing we set
 * out to remove: it needs compilers installed, it behaves differently on
 * Windows, macOS and Linux, and a sandbox built from ulimits and a temp
 * directory is far weaker than the cgroups/namespace isolation the remote
 * providers use. It survives only as an explicit opt-in escape hatch
 * (EXEC_PROVIDERS=local) for working offline on a machine that already has the
 * toolchains, and it announces itself as unsandboxed in the result.
 *
 * Never put this in the chain on a deployed server.
 */

const WIN = process.platform === 'win32';
const EXE = WIN ? 'main.exe' : 'main.out';
const PY = WIN ? 'python' : 'python3';

const SPECS = {
  javascript: { file: 'main.js', needs: [], run: (f) => ({ cmd: process.execPath, args: ['--max-old-space-size=256', '--no-warnings', f] }), managed: true },
  python: { file: 'main.py', needs: [PY], run: (f) => ({ cmd: PY, args: ['-I', '-u', '-X', 'utf8', f] }) },
  c: {
    file: 'main.c', needs: ['gcc'],
    // -lm is not optional: gcc does not link libm implicitly, so sqrt/pow with a
    // non-constant argument fails at LINK time, not compile time.
    compile: (f) => ({ cmd: 'gcc', args: [f, '-O2', '-pipe', ...(WIN ? [] : ['-pthread']), '-std=c11', '-o', EXE, '-lm'] }),
    run: (f, dir) => ({ cmd: path.join(dir, EXE), args: [] })
  },
  cpp: {
    file: 'main.cpp', needs: ['g++'],
    compile: (f) => ({ cmd: 'g++', args: [f, '-O2', '-pipe', ...(WIN ? [] : ['-pthread']), '-std=c++17', '-o', EXE, '-lm'] }),
    run: (f, dir) => ({ cmd: path.join(dir, EXE), args: [] })
  },
  java: {
    file: 'Main.java', needs: ['javac', 'java'],
    compile: (f) => ({ cmd: 'javac', args: ['-encoding', 'UTF-8', '-nowarn', '-d', '.', f] }),
    run: () => ({ cmd: 'java', args: ['-Xmx256m', '-XX:+UseSerialGC', '-Dfile.encoding=UTF-8', '-cp', '.', 'Main'] }),
    managed: true
  }
};

function onPath(bin) {
  const exts = WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try { if (statSync(path.join(dir, bin + ext.toLowerCase())).isFile()) return true; } catch { /* next */ }
    }
  }
  return false;
}

export const local = {
  name: 'local',
  label: 'Local toolchain (unsandboxed)',

  configured() {
    return process.env.EXEC_ALLOW_LOCAL === 'true' ||
      (process.env.EXEC_PROVIDERS || '').split(',').map((s) => s.trim()).includes('local');
  },

  hint() {
    return 'Development only. Requires compilers installed on the server and does NOT sandbox untrusted code.';
  },

  async languages() {
    return Object.keys(SPECS).filter((id) => SPECS[id].needs.every(onPath));
  },

  async execute({ language, code, stdin, timeoutMs, memoryKb }) {
    const spec = SPECS[language];
    if (!spec) {
      throw new ProviderError(`The local runner has no recipe for ${language}.`, {
        status: STATUS.INVALID_REQUEST, retryable: false
      });
    }
    const missing = spec.needs.filter((b) => !onPath(b));
    if (missing.length) {
      throw new ProviderError(
        `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not installed on the server.`,
        { status: STATUS.UNAVAILABLE, retryable: false }
      );
    }

    let dir;
    const started = Date.now();
    try {
      dir = await mkdtemp(path.join(tmpdir(), 'syncspace-local-'));
      await writeFile(path.join(dir, spec.file), code, 'utf8');

      if (spec.compile) {
        const c = spec.compile(spec.file, dir);
        const built = await runProcess(c.cmd, c.args, {
          cwd: dir, timeoutMs: 20000, cpuSeconds: 30, vmLimit: !spec.managed
        });
        if (built.timedOut || built.exitCode !== 0) {
          return makeResult({
            language, status: STATUS.COMPILE_ERROR, phase: 'compile',
            compileOutput: scrub(built.stderr || built.stdout, dir) || 'The compiler produced no message.',
            stderr: built.timedOut ? 'Compilation timed out.' : 'Compilation failed.',
            exitCode: built.exitCode, durationMs: Date.now() - started,
            provider: 'local', providerLabel: 'Local toolchain (unsandboxed)'
          });
        }
      }

      const r = spec.run(spec.file, dir);
      const res = await runProcess(r.cmd, r.args, {
        cwd: dir, stdin, timeoutMs, memoryKb, cpuSeconds: 10, vmLimit: !spec.managed
      });

      const status = res.timedOut ? STATUS.TIMEOUT
        : res.signal ? STATUS.RUNTIME_ERROR
          : res.exitCode === 0 ? STATUS.OK : STATUS.RUNTIME_ERROR;

      const notes = [];
      if (res.timedOut) notes.push('[stopped: exceeded the time limit]');
      else if (res.signal) notes.push(`[${signalReason(res.signal)}]`);

      return makeResult({
        language, status, phase: 'run',
        stdout: scrub(res.stdout, dir),
        stderr: [scrub(res.stderr, dir), ...notes].filter(Boolean).join('\n').trim(),
        exitCode: res.exitCode, signal: res.signal,
        exitReason: res.timedOut ? 'timeout' : res.signal ? 'signal' : 'exit',
        truncated: res.truncated,
        durationMs: Math.round(res.durationMs ?? Date.now() - started),
        provider: 'local', providerLabel: 'Local toolchain (unsandboxed)'
      });
    } finally {
      if (dir) rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }
};

/** Keep the server's temp path out of the console. */
function scrub(text, dir) {
  if (!text || !dir) return text || '';
  return String(text).split(dir + path.sep).join('').split(dir).join('');
}
