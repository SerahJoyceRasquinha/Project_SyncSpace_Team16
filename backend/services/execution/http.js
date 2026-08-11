import { STATUS, ProviderError } from './result.js';

/**
 * The only way an adapter talks to the network.
 *
 * Centralising it means every provider gets the same guarantees for free:
 * a hard deadline (no request can hang the queue), bounded retries with
 * jittered backoff on genuinely transient failures only, one consistent log
 * line per attempt, and HTTP status codes translated into the same
 * ProviderError vocabulary the orchestrator understands.
 *
 * Deliberately built on global fetch (Node 18+) rather than axios/node-fetch:
 * the backend currently has zero runtime dependencies for execution and adding
 * one for six lines of code would be a poor trade.
 */

const LOG = process.env.EXEC_LOG !== 'off';

export function log(event, data = {}) {
  if (!LOG) return;
  const payload = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : v}`)
    .join(' ');
  console.log(`[exec] ${event}${payload ? ' ' + payload : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Which failures are worth trying again.
 * 429 and 5xx are transient. 4xx (other than 429) means we sent something the
 * service will reject just as firmly the second time — retrying is pure latency.
 */
function classify(httpStatus, body) {
  if (httpStatus === 429) {
    return new ProviderError('The execution service is rate limiting requests.', {
      status: STATUS.RATE_LIMITED, retryable: true, httpStatus
    });
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return new ProviderError(
      'The execution service rejected our credentials. Check the API key in the backend .env file.',
      { status: STATUS.UNAVAILABLE, retryable: false, httpStatus }
    );
  }
  if (httpStatus === 503 || httpStatus === 502 || httpStatus === 504) {
    return new ProviderError('The execution service is temporarily unavailable.', {
      status: STATUS.UNAVAILABLE, retryable: true, httpStatus
    });
  }
  if (httpStatus >= 500) {
    return new ProviderError('The execution service reported an internal error.', {
      status: STATUS.PROVIDER_ERROR, retryable: true, httpStatus
    });
  }
  const detail = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body || {}).slice(0, 200);
  return new ProviderError(`The execution service rejected the request (HTTP ${httpStatus}). ${detail}`, {
    status: STATUS.PROVIDER_ERROR, retryable: false, httpStatus
  });
}

/**
 * JSON request with deadline + retries.
 * Resolves with the parsed body; throws ProviderError on any failure.
 */
export async function requestJson(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 15000,
  retries = 2,
  retryDelayMs = 400,
  provider = 'http',
  signal
} = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);
    const started = Date.now();

    try {
      const res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...headers },
        body,
        signal: controller.signal
      });

      const text = await res.text();
      let parsed;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

      log('http', { provider, method, url: redact(url), status: res.status, ms: Date.now() - started, attempt: attempt + 1 });

      if (!res.ok) {
        const err = classify(res.status, parsed);
        if (!err.retryable || attempt === retries) throw err;
        lastError = err;
      } else {
        if (parsed !== null && typeof parsed !== 'object') {
          throw new ProviderError('The execution service returned a response that was not JSON.', {
            status: STATUS.PROVIDER_ERROR, retryable: false
          });
        }
        return parsed;
      }
    } catch (err) {
      if (err instanceof ProviderError) {
        if (!err.retryable || attempt === retries) throw err;
        lastError = err;
      } else if (err?.name === 'AbortError') {
        const e = new ProviderError(
          signal?.aborted
            ? 'The run was cancelled.'
            : `The execution service did not answer within ${Math.round(timeoutMs / 1000)}s.`,
          { status: STATUS.UNAVAILABLE, retryable: !signal?.aborted }
        );
        log('http-timeout', { provider, url: redact(url), ms: Date.now() - started, attempt: attempt + 1 });
        if (signal?.aborted || attempt === retries) throw e;
        lastError = e;
      } else {
        // DNS failure, connection refused, TLS error, offline laptop…
        const e = new ProviderError(
          'Could not reach the execution service. Check the backend\'s internet connection.',
          { status: STATUS.UNAVAILABLE, retryable: true, cause: err }
        );
        log('http-network', { provider, url: redact(url), error: err?.code || err?.message, attempt: attempt + 1 });
        if (attempt === retries) throw e;
        lastError = e;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    // full jitter: several users hitting a rate limit together must not
    // synchronise their retries into a second thundering herd
    const backoff = retryDelayMs * 2 ** attempt;
    await sleep(Math.round(Math.random() * backoff) + 50);
  }

  throw lastError || new ProviderError('The execution service could not be reached.', {
    status: STATUS.UNAVAILABLE, retryable: false
  });
}

/** Never log a key that someone pasted into a query string. */
function redact(url) {
  return String(url).replace(/([?&](?:api_?key|token|key)=)[^&]+/gi, '$1***');
}
