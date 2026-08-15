import { SERVER_URL } from '../utils/socket';

/**
 * The one place the frontend talks to the AI backend.
 *
 * The previous version exported nine near-identical wrappers (chat, explain,
 * generate, analyzeError, debug, generateTests, optimize, convert, document),
 * each with its own positional argument order — which is precisely how
 * `convert(code, "javascript", "python")` came to be hardcoded at the call
 * site. Nine signatures meant nine places to get the language wrong.
 *
 * There is now one request shape. The caller passes named fields; this module
 * decides nothing about language, because language is resolved on the server
 * where it can be validated.
 */

/** Time allowed for the response HEADERS. The backend flushes these before it
 *  calls Gemini, so this is backend reachability, not model latency. */
const CONNECT_TIMEOUT_MS = 15_000;

/** Time allowed between two chunks once the stream is running. A long answer is
 *  legitimate; twenty seconds of silence mid-answer is not. */
const STALL_TIMEOUT_MS = 25_000;

class AIError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AIError';
    this.code = code;
  }
}

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

/**
 * Stream one AI request.
 *
 * Callbacks rather than an async iterator so the caller can keep its React
 * state updates in one place and batch them; see AIPage's flush scheduler.
 *
 * @returns {Promise<{text: string, meta: object|null, done: object|null}>}
 * @throws  {AIError} on transport failure, auth failure, or provider error
 */
export async function streamAI(request, { token, signal, onMeta, onDelta, onDone } = {}) {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort);

  let watchdog = setTimeout(() => controller.abort('timeout'), CONNECT_TIMEOUT_MS);
  const armStall = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort('timeout'), STALL_TIMEOUT_MS);
  };

  let response;
  try {
    response = await fetch(`${SERVER_URL}/api/ai/stream`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(request),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(watchdog);
    signal?.removeEventListener('abort', onOuterAbort);
    if (signal?.aborted) throw new AIError('Cancelled.', 'cancelled');
    if (error?.name === 'AbortError') {
      throw new AIError('The AI server did not respond. Is the backend running?', 'timeout');
    }
    throw new AIError('Cannot reach the AI server. Is the backend running?', 'network');
  }

  // An error before the stream starts comes back as ordinary JSON (401, 400,
  // 429...), so read it as JSON rather than trying to parse it as SSE.
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
    clearTimeout(watchdog);
    signal?.removeEventListener('abort', onOuterAbort);

    let data = null;
    try { data = await response.json(); } catch { /* no body */ }

    throw new AIError(
      data?.error || `The AI request failed (HTTP ${response.status}).`,
      data?.code || `http-${response.status}`
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let text = '';
  let meta = null;
  let done = null;
  let failure = null;

  try {
    armStall();

    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;

      armStall();
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line. Anything after the last
      // separator is a partial frame and stays in the buffer.
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        if (!frame.startsWith('data: ')) continue;

        let event;
        try {
          event = JSON.parse(frame.slice(6));
        } catch {
          continue; // a corrupt frame must not kill the stream
        }

        if (event.type === 'meta') { meta = event; onMeta?.(event); }
        else if (event.type === 'delta') { text += event.text; onDelta?.(event.text); }
        else if (event.type === 'done') { done = event; onDone?.(event); }
        else if (event.type === 'error') { failure = event; }
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      // A user-cancelled stream is not a failure: keep what arrived.
      return { text, meta, done: null, cancelled: true };
    }
    if (error?.name === 'AbortError') {
      throw new AIError(
        text
          ? 'The connection stalled partway through the answer.'
          : 'The AI service took too long to respond. Please try again.',
        'timeout'
      );
    }
    throw new AIError('The connection to the AI server was lost.', 'network');
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener('abort', onOuterAbort);
    reader.cancel().catch(() => {});
  }

  if (failure) {
    const error = new AIError(failure.message, failure.code);
    // A provider failure after partial output should still show that output.
    error.partialText = text;
    throw error;
  }

  return { text, meta, done };
}

/**
 * Buffered fallback. Used only when streaming is unavailable — an old proxy
 * that buffers event-streams, or a browser without ReadableStream on fetch.
 * Same endpoint family, same server-side planner, so answers cannot diverge.
 */
export async function sendAI(request, { token, signal } = {}) {
  let response;
  try {
    response = await fetch(`${SERVER_URL}/api/ai`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(request),
      signal
    });
  } catch {
    throw new AIError('Cannot reach the AI server. Is the backend running?', 'network');
  }

  let data = {};
  try { data = await response.json(); } catch {
    throw new AIError('The AI server returned an invalid response.', 'malformed');
  }

  if (!response.ok || data.success === false) {
    throw new AIError(data.error || 'The AI request failed. Please try again.', data.code);
  }

  return { text: data.answer || '', meta: data.meta || null, done: null };
}

/** Whether this browser can consume the stream at all. */
export function supportsStreaming() {
  return typeof ReadableStream !== 'undefined' &&
    typeof TextDecoder !== 'undefined' &&
    typeof AbortController !== 'undefined';
}

export { AIError };
