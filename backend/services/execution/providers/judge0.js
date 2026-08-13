import { LANGUAGES } from '../languages.js';
import { requestJson, log } from '../http.js';
import { STATUS, ProviderError, makeResult, signalName, signalReason } from '../result.js';

/**
 * Judge0 CE adapter — the primary provider.
 *
 * Judge0 was chosen over Piston because Piston's public API closed to new users
 * on 15 Feb 2026 and its maintainer explicitly declines keys for university and
 * portfolio projects. Judge0 is actively maintained, self-hostable, has the
 * richest documented result shape (separate compile_output, exit_code,
 * exit_signal, time and memory), and runs every language in our dropdown.
 *
 * Two implementation details matter a great deal here:
 *
 * 1. LANGUAGE IDS ARE RESOLVED AT RUNTIME. `C (GCC 9.2.0)` is id 50 on one
 *    instance and something else on the next, and every broken Judge0
 *    integration on GitHub has the number 50 hard-coded in it. We fetch
 *    GET /languages, match on the language family, and take the newest. The
 *    fallbackId in the registry is only a last resort if that call fails.
 *
 * 2. EVERYTHING IS BASE64. The docs warn that GCC emits non-printable bytes in
 *    compile errors, and any program printing emoji or CJK breaks a plain-text
 *    submission. base64_encoded=true on both the request and the response is
 *    the only way Unicode survives the round trip intact.
 */

const DEFAULT_URL = 'https://judge0-ce.p.rapidapi.com';

function config() {
  const url = (process.env.JUDGE0_URL || DEFAULT_URL).replace(/\/+$/, '');
  const key = process.env.JUDGE0_KEY || '';
  const isRapid = /rapidapi\.com/i.test(url);
  return { url, key, isRapid };
}

function authHeaders() {
  const { key, url, isRapid } = config();
  if (!key) return {};
  if (isRapid) {
    return { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': new URL(url).host };
  }
  // Self-hosted and Sulu both use the token header; the field name is
  // configurable per instance, hence the override.
  return { [process.env.JUDGE0_KEY_HEADER || 'X-Auth-Token']: key };
}

const b64 = (s) => Buffer.from(s ?? '', 'utf8').toString('base64');
const unb64 = (s) => (s ? Buffer.from(String(s), 'base64').toString('utf8') : '');

// ------------------------------------------------------------ language ids
let cache = { at: 0, byLanguage: null };
const CACHE_TTL_MS = 10 * 60 * 1000;

async function resolveLanguageIds({ signal } = {}) {
  if (cache.byLanguage && Date.now() - cache.at < CACHE_TTL_MS) return cache.byLanguage;

  const { url } = config();
  const list = await requestJson(`${url}/languages`, {
    headers: authHeaders(),
    timeoutMs: Number(process.env.JUDGE0_CATALOG_TIMEOUT_MS) || 8000,
    retries: 1,
    provider: 'judge0',
    signal
  });

  if (!Array.isArray(list)) {
    throw new ProviderError('Judge0 returned an unexpected language list.', {
      status: STATUS.PROVIDER_ERROR, retryable: false
    });
  }

  const byLanguage = {};
  for (const [id, def] of Object.entries(LANGUAGES)) {
    const matcher = def.providers.judge0?.match;
    if (!matcher) continue;
    const matches = list.filter((l) => matcher.test(String(l.name || '')));
    if (matches.length) {
      // higher Judge0 id == newer runtime, consistently across releases
      const best = matches.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
      byLanguage[id] = { id: Number(best.id), name: String(best.name) };
    }
  }

  cache = { at: Date.now(), byLanguage };
  log('judge0-catalog', { resolved: Object.keys(byLanguage).length });
  return byLanguage;
}

function fallbackFor(languageId) {
  const f = LANGUAGES[languageId]?.providers.judge0?.fallbackId;
  return f ? { id: f, name: `${LANGUAGES[languageId].label} (default id ${f})` } : null;
}

// ------------------------------------------------------------- status map
function mapStatus(statusId) {
  switch (Number(statusId)) {
    case 3: case 4: return STATUS.OK;
    case 5: return STATUS.TIMEOUT;
    case 6: return STATUS.COMPILE_ERROR;
    case 7: case 8: case 9: case 10: case 11: case 12: return STATUS.RUNTIME_ERROR;
    case 13: case 14: return STATUS.PROVIDER_ERROR;
    default: return STATUS.PROVIDER_ERROR;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const judge0 = {
  name: 'judge0',
  label: 'Judge0',

  /** Usable without a key only against a self-hosted instance that allows it. */
  configured() {
    const { key, url, isRapid } = config();
    if (key) return true;
    // a custom URL with no key is a self-hosted instance with auth disabled
    return Boolean(process.env.JUDGE0_URL) && !isRapid && Boolean(url);
  },

  hint() {
    return 'Set JUDGE0_URL and JUDGE0_KEY in backend/.env. Free options: Sulu (20k submissions) or the RapidAPI Basic plan.';
  },

  async languages({ signal } = {}) {
    const resolved = await resolveLanguageIds({ signal });
    return Object.keys(resolved);
  },

  async execute({ language, code, stdin, timeoutMs, memoryKb, signal }) {
    const { url } = config();
    const def = LANGUAGES[language];

    let target;
    try {
      target = (await resolveLanguageIds({ signal }))[language] || fallbackFor(language);
    } catch (err) {
      // The catalog call failing should not sink the run — try the known id.
      log('judge0-catalog-failed', { error: err.message });
      target = fallbackFor(language);
      if (!target) throw err;
    }
    if (!target) {
      throw new ProviderError(`Judge0 does not offer a runtime for ${def.label}.`, {
        status: STATUS.INVALID_REQUEST, retryable: false
      });
    }

    // cpu_time_limit is the real limit; wall_time_limit is the guard against a
    // program that sleeps rather than burning CPU. Judge0 caps these itself
    // (max 15s / 20s), so clamp rather than let it 422 the submission.
    const cpuSeconds = Math.min(15, Math.max(1, Math.round(timeoutMs / 1000)));
    const wallSeconds = Math.min(20, cpuSeconds + 5);

    const payload = {
      language_id: target.id,
      source_code: b64(code),
      stdin: b64(stdin || ''),
      cpu_time_limit: cpuSeconds,
      wall_time_limit: wallSeconds,
      memory_limit: Math.min(256000, Math.max(16000, memoryKb)),
      redirect_stderr_to_stdout: false
    };

    const started = Date.now();
    const httpTimeout = Number(process.env.JUDGE0_HTTP_TIMEOUT_MS) || (wallSeconds * 1000 + 15000);

    // wait=true returns the finished submission in one round trip. It is not
    // enabled on every host (the official api.judge0.com disables it), so we
    // ask for it and transparently fall back to polling when it is refused.
    let submission = await requestJson(
      `${url}/submissions?base64_encoded=true&wait=true&fields=*`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload),
        timeoutMs: httpTimeout,
        retries: 1,
        provider: 'judge0',
        signal
      }
    );

    if (submission && !submission.status && submission.token) {
      submission = await poll(url, submission.token, { wallSeconds, signal });
    }

    if (!submission || !submission.status) {
      throw new ProviderError('Judge0 returned a submission with no status.', {
        status: STATUS.PROVIDER_ERROR, retryable: true
      });
    }

    return toResult(submission, { language, target, startedAt: started });
  }
};

async function poll(url, token, { wallSeconds, signal }) {
  const deadline = Date.now() + (wallSeconds * 1000 + 20000);
  let delay = 120; // start tight — most submissions finish well under a second
  while (Date.now() < deadline) {
    const s = await requestJson(
      `${url}/submissions/${encodeURIComponent(token)}?base64_encoded=true&fields=*`,
      { headers: authHeaders(), timeoutMs: 10000, retries: 1, provider: 'judge0', signal }
    );
    const id = Number(s?.status?.id);
    if (id && id > 2) return s;          // 1 = In Queue, 2 = Processing
    await sleep(delay);
    delay = Math.min(600, Math.round(delay * 1.5));
  }
  throw new ProviderError('Judge0 did not finish the submission in time.', {
    status: STATUS.UNAVAILABLE, retryable: true
  });
}

function toResult(s, { language, target, startedAt }) {
  const status = mapStatus(s.status?.id);
  const signal = signalName(s.exit_signal);
  const stdout = unb64(s.stdout);
  let stderr = unb64(s.stderr);
  const compileOutput = unb64(s.compile_output);
  const message = unb64(s.message) || s.message || '';

  // Judge0's own note ("Time limit exceeded", isolate diagnostics) is often the
  // only explanation the user gets, so surface it rather than dropping it.
  const extra = [];
  if (status === STATUS.RUNTIME_ERROR && signal) extra.push(`[${signalReason(signal)}]`);
  if (status === STATUS.TIMEOUT) extra.push('[stopped: exceeded the time limit]');
  if (message && !stderr.includes(message)) extra.push(`[${message.trim()}]`);
  if (extra.length) stderr = [stderr, ...extra].filter(Boolean).join('\n').trim();

  const statusText =
    status === STATUS.OK ? 'Finished successfully.'
      : status === STATUS.COMPILE_ERROR ? 'The program did not compile.'
        : status === STATUS.TIMEOUT ? 'The program was stopped for taking too long.'
          : status === STATUS.RUNTIME_ERROR
            ? (signal ? signalReason(signal) : 'The program exited with a runtime error.')
            : (s.status?.description ? `Judge0: ${s.status.description}` : undefined);

  return makeResult({
    language,
    status,
    phase: status === STATUS.COMPILE_ERROR ? 'compile' : 'run',
    stdout,
    stderr,
    compileOutput,
    exitCode: s.exit_code ?? null,
    signal,
    exitReason: status === STATUS.TIMEOUT ? 'timeout' : signal ? 'signal' : 'exit',
    statusText,
    // Judge0 reports CPU seconds; wall time from our side is what the user feels
    durationMs: s.time != null ? Math.round(Number(s.time) * 1000) : Date.now() - startedAt,
    memoryKb: s.memory != null ? Number(s.memory) : null,
    provider: 'judge0',
    providerLabel: `Judge0 · ${target.name}`
  });
}
