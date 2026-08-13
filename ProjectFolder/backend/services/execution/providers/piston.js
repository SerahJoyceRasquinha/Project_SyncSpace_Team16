import { LANGUAGES } from '../languages.js';
import { requestJson } from '../http.js';
import { STATUS, ProviderError, makeResult, signalName, signalReason } from '../result.js';

/**
 * Piston adapter — secondary provider.
 *
 * Kept because Piston is excellent software and remains a first-class option
 * for anyone who self-hosts it (docker compose, one command) or who has been
 * granted a key. It is NOT the default: the public instance at emkc.org closed
 * to new users on 15 Feb 2026, and the maintainer states that keys are not
 * issued for university assignments or portfolio projects.
 *
 * Point PISTON_URL at your own instance and this becomes a fully local-network
 * provider with no third-party dependency at all.
 */

const DEFAULT_URL = 'https://emkc.org/api/v2/piston';

const config = () => ({
  url: (process.env.PISTON_URL || DEFAULT_URL).replace(/\/+$/, ''),
  key: process.env.PISTON_KEY || ''
});

const authHeaders = () => {
  const { key } = config();
  return key ? { Authorization: key } : {};
};

let cache = { at: 0, runtimes: null };
const CACHE_TTL_MS = 10 * 60 * 1000;

async function runtimes({ signal } = {}) {
  if (cache.runtimes && Date.now() - cache.at < CACHE_TTL_MS) return cache.runtimes;
  const { url } = config();
  const list = await requestJson(`${url}/runtimes`, {
    headers: authHeaders(), timeoutMs: 8000, retries: 1, provider: 'piston', signal
  });
  if (!Array.isArray(list)) {
    throw new ProviderError('Piston returned an unexpected runtime list.', {
      status: STATUS.PROVIDER_ERROR, retryable: false
    });
  }
  cache = { at: Date.now(), runtimes: list };
  return list;
}

/** Piston matches on language name OR alias, so check both. */
function findRuntime(list, wanted, wantedVersion) {
  const hits = list.filter((r) =>
    String(r.language).toLowerCase() === wanted ||
    (Array.isArray(r.aliases) && r.aliases.some((a) => String(a).toLowerCase() === wanted))
  );
  if (!hits.length) return null;
  if (wantedVersion) {
    const exact = hits.find((r) => String(r.version).startsWith(wantedVersion));
    if (exact) return exact;
  }
  return hits[hits.length - 1];
}

export const piston = {
  name: 'piston',
  label: 'Piston',

  configured() {
    // The public instance now requires a key, so bare Piston is only usable
    // when explicitly pointed somewhere (a self-hosted box) or given one.
    return Boolean(process.env.PISTON_URL || process.env.PISTON_KEY);
  },

  hint() {
    return 'Set PISTON_URL to your own Piston instance (docker compose up -d api), or PISTON_KEY if you have been granted access to the public one.';
  },

  async languages({ signal } = {}) {
    const list = await runtimes({ signal });
    return Object.keys(LANGUAGES).filter((id) => {
      const m = LANGUAGES[id].providers.piston;
      return m && findRuntime(list, m.language, m.version);
    });
  },

  async execute({ language, code, stdin, timeoutMs, memoryKb, signal }) {
    const { url } = config();
    const def = LANGUAGES[language];
    const map = def.providers.piston;

    let runtime = null;
    try {
      runtime = findRuntime(await runtimes({ signal }), map.language, map.version);
    } catch {
      // fall through: Piston accepts "*" as "newest version you have"
    }

    const body = {
      language: map.language,
      version: runtime?.version || map.version || '*',
      files: [{ name: def.filename, content: code }],
      stdin: stdin || '',
      compile_timeout: 20000,
      run_timeout: timeoutMs,
      run_memory_limit: memoryKb * 1024
    };

    const started = Date.now();
    const res = await requestJson(`${url}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
      timeoutMs: timeoutMs + 25000,
      retries: 1,
      provider: 'piston',
      signal
    });

    if (!res || (!res.run && !res.compile)) {
      throw new ProviderError('Piston returned a response with no run result.', {
        status: STATUS.PROVIDER_ERROR, retryable: true
      });
    }

    // Piston reports a compile failure as a non-zero code on the compile stage.
    const compile = res.compile;
    if (compile && compile.code !== 0 && compile.code != null) {
      return makeResult({
        language,
        status: STATUS.COMPILE_ERROR,
        phase: 'compile',
        compileOutput: compile.stderr || compile.output || compile.stdout || '',
        stderr: 'Compilation failed.',
        exitCode: compile.code,
        durationMs: Date.now() - started,
        provider: 'piston',
        providerLabel: `Piston · ${res.language} ${res.version}`
      });
    }

    const run = res.run || {};
    const signalStr = signalName(run.signal);
    // Piston kills on timeout with SIGKILL and gives no other marker.
    const timedOut = signalStr === 'SIGKILL' && Date.now() - started >= timeoutMs - 250;

    const status = timedOut ? STATUS.TIMEOUT
      : signalStr ? STATUS.RUNTIME_ERROR
        : run.code === 0 ? STATUS.OK : STATUS.RUNTIME_ERROR;

    const notes = [];
    if (timedOut) notes.push('[stopped: exceeded the time limit]');
    else if (signalStr) notes.push(`[${signalReason(signalStr)}]`);

    return makeResult({
      language,
      status,
      phase: 'run',
      stdout: run.stdout || '',
      stderr: [run.stderr || '', ...notes].filter(Boolean).join('\n').trim(),
      compileOutput: compile?.stderr || '',
      exitCode: run.code ?? null,
      signal: signalStr,
      exitReason: timedOut ? 'timeout' : signalStr ? 'signal' : 'exit',
      statusText: timedOut ? 'The program was stopped for taking too long.'
        : signalStr ? signalReason(signalStr) : undefined,
      durationMs: Date.now() - started,
      provider: 'piston',
      providerLabel: `Piston · ${res.language} ${res.version}`
    });
  }
};
