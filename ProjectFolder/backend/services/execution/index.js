import { LANGUAGES, LANGUAGE_IDS, isLanguage, baseCatalog, preflightWarning } from './languages.js';
import { resolveChain, PROVIDERS, DEFAULT_CHAIN } from './providers/index.js';
import { STATUS, ProviderError, makeResult } from './result.js';
import { log } from './http.js';

/**
 * The execution orchestrator — provider-agnostic by construction.
 *
 * It knows about queueing, validation, timeouts and fallback. It does NOT know
 * what Judge0 or Piston are: it walks a chain of adapters, each of which
 * returns the canonical result shape from result.js. Swapping providers is an
 * .env change; adding one is a new file in providers/.
 *
 * It also stays completely independent of the collaboration server. It imports
 * nothing from socketService or workspaceStore and holds no per-workspace
 * state, so a run cannot touch document sync, the whiteboard, replay, the
 * waiting room or admin controls. Isolation between users is therefore
 * structural rather than something we have to remember to enforce: each call
 * is a self-contained request to a remote sandbox, keyed by nothing.
 */

const RUN_TIMEOUT_MS = Number(process.env.EXEC_RUN_TIMEOUT_MS) || 8000;
const MEMORY_KB = Number(process.env.EXEC_MEMORY_KB) || 128000;
const MAX_CONCURRENT = Number(process.env.EXEC_MAX_CONCURRENT) || 8;
const MAX_QUEUE = Number(process.env.EXEC_MAX_QUEUE) || 32;
const QUEUE_TIMEOUT_MS = Number(process.env.EXEC_QUEUE_TIMEOUT_MS) || 20000;
const MAX_CODE_BYTES = Number(process.env.EXEC_MAX_CODE_BYTES) || 256 * 1024;
const MAX_STDIN_BYTES = Number(process.env.EXEC_MAX_STDIN_BYTES) || 64 * 1024;
const PROBE_TTL_MS = Number(process.env.EXEC_PROBE_TTL_MS) || 5 * 60 * 1000;

// Concurrency here protects OUR backend's sockets and the provider's rate
// limit, not a CPU: the work happens elsewhere, so the cap is far higher than
// it was when we forked compilers locally.
let running = 0;
const waiting = [];

function acquireSlot() {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve({ ok: true, queuedMs: 0 });
  }
  if (waiting.length >= MAX_QUEUE) {
    return Promise.resolve({
      ok: false,
      reason: 'The server is already running as much code as it can handle. Try again in a moment.'
    });
  }
  return new Promise((resolve) => {
    const at = Date.now();
    const entry = {
      settle(ok) {
        if (entry.done) return;
        entry.done = true;
        clearTimeout(entry.timer);
        const i = waiting.indexOf(entry);
        if (i !== -1) waiting.splice(i, 1);
        resolve(ok
          ? { ok: true, queuedMs: Date.now() - at }
          : { ok: false, reason: 'Timed out waiting for a free execution slot. The server is busy — try again.' });
      }
    };
    entry.timer = setTimeout(() => entry.settle(false), QUEUE_TIMEOUT_MS);
    entry.timer.unref?.();
    waiting.push(entry);
  });
}

function releaseSlot() {
  while (waiting.length) {
    const next = waiting.shift();
    if (next.done) continue;
    next.settle(true);
    return;
  }
  running = Math.max(0, running - 1);
}

// ----------------------------------------------------------- provider probe
let probe = { at: 0, inFlight: null, results: null };

async function probeProviders(force = false) {
  if (!force && probe.results && Date.now() - probe.at < PROBE_TTL_MS) return probe.results;
  if (probe.inFlight) return probe.inFlight;

  probe.inFlight = (async () => {
    const chain = resolveChain();
    const results = [];
    for (const p of chain) {
      if (!p.configured()) {
        results.push({ name: p.name, label: p.label, configured: false, reachable: false, languages: [], hint: p.hint() });
        continue;
      }
      try {
        const languages = await p.languages({});
        results.push({ name: p.name, label: p.label, configured: true, reachable: true, languages, hint: null });
        log('probe-ok', { provider: p.name, languages: languages.length });
      } catch (err) {
        results.push({
          name: p.name, label: p.label, configured: true, reachable: false, languages: [],
          hint: err.message
        });
        log('probe-failed', { provider: p.name, error: err.message });
      }
    }
    probe = { at: Date.now(), inFlight: null, results };
    return results;
  })();

  return probe.inFlight;
}

export async function refreshProviders() {
  await probeProviders(true);
  return providerStatus();
}

export function providerStatus() {
  const chain = resolveChain();
  return {
    chain: chain.map((p) => p.name),
    configured: chain.filter((p) => p.configured()).map((p) => p.name),
    probed: probe.results || null,
    probedAt: probe.at || null
  };
}

export function executionStats() {
  return { running, queued: waiting.length, maxConcurrent: MAX_CONCURRENT, maxQueue: MAX_QUEUE };
}

// ------------------------------------------------------------------ catalog
/**
 * The dropdown.
 *
 * Availability is deliberately optimistic until a probe has completed: the
 * catalog must answer instantly when the editor mounts, and blocking it behind
 * a network round trip would make the UI feel broken. Once a probe lands, the
 * answer becomes exact and the client can refresh.
 */
export async function languageCatalog({ wait = false } = {}) {
  const chain = resolveChain();
  const anyConfigured = chain.some((p) => p.configured());

  let probed = probe.results;
  if (wait || !probed) {
    const p = probeProviders();
    if (wait) probed = await p;
  }

  const supported = probed
    ? new Set(probed.filter((r) => r.reachable).flatMap((r) => r.languages))
    : null;

  const languages = baseCatalog().map((l) => {
    const available = supported ? supported.has(l.id) : anyConfigured;
    return {
      ...l,
      available,
      note: available ? undefined : unavailableNote(l, probed, anyConfigured)
    };
  });

  return { languages, providers: providerStatus(), stats: executionStats() };
}

function unavailableNote(lang, probed, anyConfigured) {
  if (!anyConfigured) {
    return `No execution provider is configured. Set JUDGE0_URL and JUDGE0_KEY in backend/.env (see EXECUTION.md), or leave paiza.io enabled for a no-signup fallback.`;
  }
  if (!probed) return `Checking which execution providers can run ${lang.label}…`;
  const reachable = probed.filter((r) => r.reachable);
  if (!reachable.length) {
    return `No execution provider is reachable right now. ${probed.map((r) => `${r.label}: ${r.hint || 'unavailable'}`).join(' · ')}`;
  }
  return `None of the reachable providers offers ${lang.label}.`;
}

// ------------------------------------------------------------------ execute
/**
 * Run one snippet. Always RESOLVES with the canonical result shape — a failure
 * is data, never an exception, because the editor has to render the reason.
 */
export async function executeCode({ language, code, stdin = '', meta = {} } = {}) {
  const invalid = validate({ language, code, stdin });
  if (invalid) return invalid;

  const warnings = [];
  const preflight = preflightWarning(language, code);
  if (preflight) warnings.push(preflight);

  let input = typeof stdin === 'string' ? stdin : '';
  if (Buffer.byteLength(input) > MAX_STDIN_BYTES) {
    input = Buffer.from(input).subarray(0, MAX_STDIN_BYTES).toString('utf8');
    warnings.push(`Program input was clipped to ${MAX_STDIN_BYTES / 1024} KB.`);
  }
  // scanf / getline / Scanner all expect a terminator after the last value
  if (input && !input.endsWith('\n')) input += '\n';

  const slot = await acquireSlot();
  if (!slot.ok) {
    return makeResult({
      language, status: STATUS.UNAVAILABLE, phase: 'setup',
      stderr: slot.reason, statusText: slot.reason, warnings
    });
  }

  const chain = resolveChain();
  const failures = [];
  let attempts = 0;
  const startedAt = Date.now();

  try {
    for (const provider of chain) {
      if (!provider.configured()) {
        failures.push(`${provider.label}: not configured. ${provider.hint()}`);
        continue;
      }
      if (!LANGUAGES[language].providers[provider.name]) {
        failures.push(`${provider.label}: no runtime mapping for ${LANGUAGES[language].label}.`);
        continue;
      }

      attempts += 1;
      try {
        log('run', { provider: provider.name, language, workspace: meta.workspaceId, bytes: Buffer.byteLength(code) });
        const result = await provider.execute({
          language,
          code,
          stdin: input,
          timeoutMs: RUN_TIMEOUT_MS,
          memoryKb: MEMORY_KB
        });
        log('run-done', {
          provider: provider.name, language, status: result.status,
          ms: Date.now() - startedAt, exit: result.exitCode
        });
        return { ...result, attempts, queuedMs: slot.queuedMs, warnings: [...warnings, ...result.warnings] };
      } catch (err) {
        const message = err instanceof ProviderError ? err.message : `Unexpected error: ${err.message}`;
        failures.push(`${provider.label}: ${message}`);
        log('run-failed', { provider: provider.name, language, error: message });

        // A provider that rejected the REQUEST will reject it again; only fall
        // through when the provider itself is the problem.
        if (err instanceof ProviderError && err.status === STATUS.INVALID_REQUEST) break;
      }
    }

    const status = failures.length ? STATUS.UNAVAILABLE : STATUS.INVALID_REQUEST;
    return makeResult({
      language, status, phase: 'setup', attempts, warnings,
      statusText: 'Could not run the code — no execution provider was able to take it.',
      stderr: [
        'Could not run the code. Every configured execution provider failed:',
        ...failures.map((f) => `  • ${f}`),
        '',
        'See EXECUTION.md for how to configure a provider.'
      ].join('\n')
    });
  } finally {
    releaseSlot();
  }
}

function validate({ language, code, stdin }) {
  if (typeof language !== 'string' || !language) {
    return makeResult({
      language: null, status: STATUS.INVALID_REQUEST, phase: 'setup',
      stderr: 'Pick a language before running the code.'
    });
  }
  if (!isLanguage(language)) {
    return makeResult({
      language, status: STATUS.INVALID_REQUEST, phase: 'setup',
      stderr: `Unknown language "${language}". Supported: ${LANGUAGE_IDS.join(', ')}.`
    });
  }
  if (typeof code !== 'string' || !code.trim()) {
    return makeResult({
      language, status: STATUS.INVALID_REQUEST, phase: 'setup',
      stderr: 'There is no code to run.'
    });
  }
  if (Buffer.byteLength(code) > MAX_CODE_BYTES) {
    return makeResult({
      language, status: STATUS.INVALID_REQUEST, phase: 'setup',
      stderr: `Program too large (limit ${MAX_CODE_BYTES / 1024} KB).`
    });
  }
  if (stdin !== undefined && stdin !== null && typeof stdin !== 'string') {
    return makeResult({
      language, status: STATUS.INVALID_REQUEST, phase: 'setup',
      stderr: 'Program input (stdin) must be sent as text.'
    });
  }
  return null;
}

export { PROVIDERS, DEFAULT_CHAIN, LANGUAGE_IDS };
