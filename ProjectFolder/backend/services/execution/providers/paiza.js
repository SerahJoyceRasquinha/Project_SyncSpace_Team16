import { LANGUAGES } from '../languages.js';
import { requestJson } from '../http.js';
import { STATUS, ProviderError, makeResult } from '../result.js';

/**
 * paiza.io adapter — the zero-signup fallback.
 *
 * Its role is narrow and deliberate: it is the only provider in this project
 * that works with no account, no key and no configuration, so a freshly
 * unzipped copy of SyncSpace can run code immediately. That matters for a
 * demo, and it is why it stays in the chain even though Judge0 is better.
 *
 * The honest caveats, since they drive the ordering:
 *   - the guest key is rate limited and the limits are not published;
 *   - it is a Japanese service whose terms of use are Japanese-only;
 *   - the result shape is coarser (no signal, no memory figure, and a timeout
 *     is a string rather than a status code).
 * So: last in the chain, and never preferred over a configured Judge0.
 */

const BASE = (process.env.PAIZA_URL || 'https://api.paiza.io').replace(/\/+$/, '');
const KEY = process.env.PAIZA_KEY || 'guest';

const form = (obj) =>
  Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const paiza = {
  name: 'paiza',
  label: 'paiza.io',

  /** Always usable — that is the entire point of keeping it. */
  configured() {
    return process.env.PAIZA_ENABLED !== 'false';
  },

  hint() {
    return 'No configuration needed. Set PAIZA_ENABLED=false to remove it from the chain.';
  },

  async languages() {
    return Object.keys(LANGUAGES).filter((id) => LANGUAGES[id].providers.paiza);
  },

  async execute({ language, code, stdin, timeoutMs, signal }) {
    const map = LANGUAGES[language].providers.paiza;
    if (!map) {
      throw new ProviderError(`paiza.io has no runtime for ${LANGUAGES[language].label}.`, {
        status: STATUS.INVALID_REQUEST, retryable: false
      });
    }

    const started = Date.now();

    // longpoll makes the create call block until the run finishes, which turns
    // the usual create/poll/poll/poll round trips into one.
    const created = await requestJson(`${BASE}/runners/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        source_code: code,
        language: map.language,
        input: stdin || '',
        longpoll: 'true',
        longpoll_timeout: Math.min(30, Math.ceil(timeoutMs / 1000) + 10),
        api_key: KEY
      }),
      timeoutMs: timeoutMs + 30000,
      retries: 1,
      provider: 'paiza',
      signal
    });

    if (!created?.id) {
      throw new ProviderError(
        created?.error ? `paiza.io refused the request: ${created.error}` : 'paiza.io did not return a job id.',
        { status: STATUS.PROVIDER_ERROR, retryable: true }
      );
    }

    // longpoll usually returns completed; poll only if it timed out waiting
    let status = created.status;
    const deadline = Date.now() + timeoutMs + 30000;
    while (status !== 'completed' && Date.now() < deadline) {
      await sleep(350);
      const s = await requestJson(
        `${BASE}/runners/get_status?${form({ id: created.id, api_key: KEY })}`,
        { timeoutMs: 10000, retries: 1, provider: 'paiza', signal }
      );
      status = s?.status;
    }
    if (status !== 'completed') {
      throw new ProviderError('paiza.io did not finish the job in time.', {
        status: STATUS.UNAVAILABLE, retryable: true
      });
    }

    const d = await requestJson(
      `${BASE}/runners/get_details?${form({ id: created.id, api_key: KEY })}`,
      { timeoutMs: 15000, retries: 1, provider: 'paiza', signal }
    );

    return toResult(d, { language, startedAt: started });
  }
};

function toResult(d, { language, startedAt }) {
  const buildFailed = d.build_result && d.build_result !== 'success';

  if (buildFailed) {
    return makeResult({
      language,
      status: d.build_result === 'timeout' ? STATUS.TIMEOUT : STATUS.COMPILE_ERROR,
      phase: 'compile',
      compileOutput: d.build_stderr || d.build_stdout || '',
      stderr: d.build_result === 'timeout' ? 'Compilation timed out.' : 'Compilation failed.',
      exitCode: d.build_exit_code ?? null,
      durationMs: Date.now() - startedAt,
      provider: 'paiza',
      providerLabel: `paiza.io · ${d.language || language}`
    });
  }

  const timedOut = d.result === 'timeout';
  const exitCode = d.exit_code == null ? null : Number(d.exit_code);
  const status = timedOut ? STATUS.TIMEOUT : exitCode === 0 ? STATUS.OK : STATUS.RUNTIME_ERROR;

  return makeResult({
    language,
    status,
    phase: 'run',
    stdout: d.stdout || '',
    stderr: [d.stderr || '', timedOut ? '[stopped: exceeded the time limit]' : '']
      .filter(Boolean).join('\n').trim(),
    compileOutput: d.build_stderr || '',
    exitCode,
    exitReason: timedOut ? 'timeout' : 'exit',
    statusText: timedOut ? 'The program was stopped for taking too long.' : undefined,
    durationMs: d.time != null ? Math.round(Number(d.time) * 1000) : Date.now() - startedAt,
    memoryKb: d.memory != null ? Math.round(Number(d.memory) / 1024) : null,
    provider: 'paiza',
    providerLabel: `paiza.io · ${d.language || language}`
  });
}
