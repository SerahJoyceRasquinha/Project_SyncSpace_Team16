import http from 'http';
import { local } from '../services/execution/providers/local.js';

/**
 * A faithful stand-in for the three execution providers, used by the test
 * suite. It speaks the real wire formats of Judge0, Piston and paiza.io, and
 * behind each of them it genuinely compiles and runs the submitted program
 * with the local toolchain — so the adapters are exercised against real
 * compiler output, real exit codes and real Unicode, not canned fixtures.
 *
 * It also injects faults on demand (429, 503, malformed bodies, token-only
 * responses that force the polling path), which is the only practical way to
 * test retry, backoff and provider fallback deterministically.
 */

const control = { fail: {}, tokenOnly: false, slow: 0 };

const LANG_LIST = [
  { id: 50, name: 'C (GCC 9.2.0)' },
  { id: 103, name: 'C (GCC 14.1.0)' },
  { id: 54, name: 'C++ (GCC 9.2.0)' },
  { id: 105, name: 'C++ (GCC 14.1.0)' },
  { id: 62, name: 'Java (OpenJDK 13.0.1)' },
  { id: 91, name: 'Java (JDK 17.0.6)' },
  { id: 63, name: 'JavaScript (Node.js 12.14.0)' },
  { id: 102, name: 'JavaScript (Node.js 22.08.0)' },
  { id: 70, name: 'Python (2.7.17)' },
  { id: 71, name: 'Python (3.8.1)' },
  { id: 100, name: 'Python (3.12.5)' },
  { id: 46, name: 'Bash (5.0.0)' }
];

const ID_TO_LANG = {
  50: 'c', 103: 'c', 54: 'cpp', 105: 'cpp', 62: 'java', 91: 'java',
  63: 'javascript', 102: 'javascript', 70: 'python', 71: 'python', 100: 'python'
};

const PISTON_RUNTIMES = [
  { language: 'c', version: '10.2.0', aliases: ['gcc'] },
  { language: 'c++', version: '10.2.0', aliases: ['cpp', 'g++'] },
  { language: 'java', version: '15.0.2', aliases: [] },
  { language: 'javascript', version: '18.15.0', aliases: ['node', 'js'] },
  { language: 'python', version: '3.10.0', aliases: ['py', 'python3'] }
];

const PISTON_TO_LANG = { c: 'c', 'c++': 'cpp', java: 'java', javascript: 'javascript', python: 'python' };
const PAIZA_TO_LANG = { c: 'c', cpp: 'cpp', java: 'java', javascript: 'javascript', python3: 'python' };

const b64 = (s) => Buffer.from(s ?? '', 'utf8').toString('base64');
const unb64 = (s) => (s ? Buffer.from(String(s), 'base64').toString('utf8') : '');

const SIGNAL_NUM = { SIGILL: 4, SIGABRT: 6, SIGFPE: 8, SIGKILL: 9, SIGSEGV: 11, SIGXCPU: 24 };

/** canonical result -> Judge0 status id */
function judge0Status(r) {
  if (r.status === 'compile_error') return 6;
  if (r.status === 'timeout') return 5;
  if (r.status === 'runtime_error') {
    const n = SIGNAL_NUM[r.signal];
    if (n === 11) return 7;
    if (n === 8) return 9;
    if (n === 6) return 10;
    if (r.signal) return 12;
    return 11; // NZEC
  }
  return 3;
}

const jobs = new Map();

async function run(language, code, stdin, timeoutMs = 8000) {
  return local.execute({ language, code, stdin, timeoutMs, memoryKb: 128000 });
}

function send(res, code, body, type = 'application/json') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

/** Consume a one-shot fault, e.g. { 'judge0-submit': [429, 429] }. */
function takeFault(key) {
  const q = control.fail[key];
  if (Array.isArray(q) && q.length) return q.shift();
  return null;
}

export function createMockServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    try {
      // ---- test control ------------------------------------------------
      if (p === '/__control' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        control.fail = body.fail || {};
        control.tokenOnly = Boolean(body.tokenOnly);
        control.slow = Number(body.slow) || 0;
        return send(res, 200, { ok: true });
      }

      if (control.slow) await new Promise((r) => setTimeout(r, control.slow));

      // ---- Judge0 ------------------------------------------------------
      if (p === '/judge0/languages') {
        const fault = takeFault('judge0-languages');
        if (fault) return send(res, fault, { error: 'injected' });
        return send(res, 200, LANG_LIST);
      }

      if (p === '/judge0/submissions' && req.method === 'POST') {
        const fault = takeFault('judge0-submit');
        if (fault === 'garbage') return send(res, 200, 'not json at all', 'text/plain');
        if (fault) return send(res, fault, { error: 'injected failure' });

        const body = JSON.parse(await readBody(req) || '{}');
        const language = ID_TO_LANG[Number(body.language_id)];
        if (!language) return send(res, 422, { language_id: ['language with id ' + body.language_id + " doesn't exist"] });

        const code = unb64(body.source_code);
        const stdin = unb64(body.stdin);
        const timeoutMs = (Number(body.cpu_time_limit) || 8) * 1000;
        const r = await run(language, code, stdin, timeoutMs);
        const submission = {
          token: 'tok-' + Math.random().toString(36).slice(2, 10),
          stdout: b64(r.stdout), stderr: b64(r.stderr), compile_output: b64(r.compileOutput),
          message: b64(r.status === 'timeout' ? 'Time limit exceeded' : ''),
          exit_code: r.exitCode, exit_signal: SIGNAL_NUM[r.signal] ?? null,
          time: r.durationMs != null ? (r.durationMs / 1000).toFixed(3) : null,
          memory: r.memoryKb ?? 3200,
          status: { id: judge0Status(r), description: 'mock' }
        };

        // Some hosts refuse wait=true and hand back only a token.
        if (control.tokenOnly || url.searchParams.get('wait') !== 'true') {
          jobs.set(submission.token, submission);
          return send(res, 201, { token: submission.token });
        }
        return send(res, 201, submission);
      }

      if (p.startsWith('/judge0/submissions/') && req.method === 'GET') {
        const token = decodeURIComponent(p.split('/').pop());
        const job = jobs.get(token);
        if (!job) return send(res, 404, { error: 'no such submission' });
        // report queued once, so the adapter's polling loop is exercised
        if (!job.__polled) { job.__polled = true; return send(res, 200, { status: { id: 1, description: 'In Queue' } }); }
        return send(res, 200, job);
      }

      // ---- Piston -------------------------------------------------------
      if (p === '/piston/runtimes') {
        const fault = takeFault('piston-runtimes');
        if (fault) return send(res, fault, { error: 'injected' });
        return send(res, 200, PISTON_RUNTIMES);
      }

      if (p === '/piston/execute' && req.method === 'POST') {
        const fault = takeFault('piston-execute');
        if (fault) return send(res, fault, { error: 'injected failure' });
        const body = JSON.parse(await readBody(req) || '{}');
        const language = PISTON_TO_LANG[String(body.language).toLowerCase()];
        if (!language) return send(res, 400, { message: 'unsupported language' });
        const code = body.files?.[0]?.content || '';
        const r = await run(language, code, body.stdin, body.run_timeout || 8000);
        const out = {
          language: body.language, version: body.version,
          run: {
            stdout: r.stdout, stderr: r.stderr, output: r.stdout + r.stderr,
            code: r.status === 'timeout' ? null : r.exitCode,
            signal: r.status === 'timeout' ? 'SIGKILL' : r.signal
          }
        };
        if (r.phase === 'compile') {
          out.compile = { stdout: '', stderr: r.compileOutput, output: r.compileOutput, code: 1, signal: null };
          out.run = { stdout: '', stderr: '', output: '', code: null, signal: null };
        } else if (r.compileOutput) {
          out.compile = { stdout: '', stderr: r.compileOutput, output: r.compileOutput, code: 0, signal: null };
        }
        return send(res, 200, out);
      }

      // ---- paiza.io ------------------------------------------------------
      if (p === '/paiza/runners/create' && req.method === 'POST') {
        const fault = takeFault('paiza-create');
        if (fault) return send(res, fault, { error: 'injected failure' });
        const params = new URLSearchParams(await readBody(req));
        const language = PAIZA_TO_LANG[params.get('language')];
        if (!language) return send(res, 400, { error: 'unsupported language' });
        const r = await run(language, params.get('source_code') || '', params.get('input') || '');
        const id = 'paiza-' + Math.random().toString(36).slice(2, 10);
        jobs.set(id, {
          id, language: params.get('language'), status: 'completed',
          build_result: r.phase === 'compile' ? 'failure' : 'success',
          build_stdout: '', build_stderr: r.compileOutput, build_exit_code: r.phase === 'compile' ? 1 : 0,
          stdout: r.stdout, stderr: r.stderr,
          exit_code: r.exitCode ?? 1,
          result: r.status === 'timeout' ? 'timeout' : r.status === 'ok' ? 'success' : 'failure',
          time: r.durationMs != null ? (r.durationMs / 1000).toFixed(3) : '0.01',
          memory: 4096000
        });
        return send(res, 200, { id, status: 'completed' });
      }

      if (p === '/paiza/runners/get_status') {
        return send(res, 200, { id: url.searchParams.get('id'), status: 'completed' });
      }

      if (p === '/paiza/runners/get_details') {
        const job = jobs.get(url.searchParams.get('id'));
        if (!job) return send(res, 404, { error: 'no such job' });
        return send(res, 200, job);
      }

      return send(res, 404, { error: 'mock: no route for ' + p });
    } catch (err) {
      return send(res, 500, { error: 'mock crashed: ' + err.message });
    }
  });

  return {
    server,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
    setControl: (c) => { control.fail = c.fail || {}; control.tokenOnly = Boolean(c.tokenOnly); control.slow = Number(c.slow) || 0; }
  };
}
