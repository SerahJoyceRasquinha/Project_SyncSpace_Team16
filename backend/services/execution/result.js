/**
 * The canonical execution result.
 *
 * Every provider adapter must return THIS shape and nothing else. That is what
 * makes the output panel identical across languages and providers: the UI never
 * sees a Judge0 `status.id`, a Piston `signal`, or a Paiza `build_result`, so it
 * cannot accidentally render differently depending on where the code ran.
 *
 * {
 *   ok            boolean  — program compiled AND ran AND exited 0
 *   phase         'setup' | 'compile' | 'run'
 *   language      string   — SyncSpace language id, echoed back
 *   stdout        string
 *   stderr        string
 *   compileOutput string   — compiler diagnostics, kept separate from stderr
 *   exitCode      number | null
 *   signal        string | null
 *   exitReason    'exit' | 'signal' | 'timeout' | 'error'
 *   status        machine-readable outcome, see STATUS below
 *   statusText    one human sentence describing the outcome
 *   timedOut      boolean
 *   truncated     boolean  — output was capped by us
 *   durationMs    number | null
 *   memoryKb      number | null
 *   provider      string   — which backend actually ran it
 *   providerLabel string   — e.g. "Judge0 · C (GCC 9.2.0)"
 *   attempts      number   — how many providers/retries it took
 *   warnings      string[] — non-fatal notes (e.g. the Java class-name check)
 * }
 */

export const STATUS = {
  OK: 'ok',
  COMPILE_ERROR: 'compile_error',
  RUNTIME_ERROR: 'runtime_error',
  TIMEOUT: 'timeout',
  MEMORY: 'memory_limit',
  OUTPUT_LIMIT: 'output_limit',
  PROVIDER_ERROR: 'provider_error',
  RATE_LIMITED: 'rate_limited',
  UNAVAILABLE: 'unavailable',
  INVALID_REQUEST: 'invalid_request'
};

/** Per-stream cap applied to EVERY provider's output, before it leaves the backend. */
export const MAX_STREAM_BYTES = 64 * 1024;

/**
 * Cap one stream at MAX_STREAM_BYTES and say so in-band.
 * Providers each have their own (undocumented, inconsistent) limits; applying
 * our own on top means the frontend has exactly one number to reason about.
 */
export function capStream(text) {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  const bytes = Buffer.byteLength(s);
  if (bytes < MAX_STREAM_BYTES) return { text: s, truncated: false };

  // A stream sitting exactly ON the limit was almost certainly clipped by the
  // provider before it reached us — none of them report that they did it, and
  // Judge0's wire format has no "truncated" field at all. Saying "truncated"
  // for an output that genuinely ended at 65536 bytes is a far smaller lie
  // than silently presenting a cut-off program's output as complete.
  const cut = bytes > MAX_STREAM_BYTES
    ? Buffer.from(s).subarray(0, MAX_STREAM_BYTES).toString('utf8')
    : s;
  return {
    text: cut + `\n… output truncated at ${MAX_STREAM_BYTES / 1024} KB`,
    truncated: true
  };
}

/** Build a complete result from partial fields, so no adapter can omit one. */
export function makeResult(fields = {}) {
  const stdout = capStream(fields.stdout);
  const stderr = capStream(fields.stderr);
  const compileOutput = capStream(fields.compileOutput);

  const status = fields.status || STATUS.PROVIDER_ERROR;
  const phase = fields.phase || (status === STATUS.COMPILE_ERROR ? 'compile' : 'run');

  return {
    ok: status === STATUS.OK,
    phase,
    language: fields.language ?? null,
    stdout: stdout.text,
    stderr: stderr.text,
    compileOutput: compileOutput.text,
    exitCode: fields.exitCode ?? null,
    signal: fields.signal ?? null,
    exitReason: fields.exitReason || (status === STATUS.TIMEOUT ? 'timeout' : 'exit'),
    status,
    statusText: fields.statusText || describe(status),
    timedOut: status === STATUS.TIMEOUT,
    truncated: Boolean(
      fields.truncated || stdout.truncated || stderr.truncated || compileOutput.truncated
    ),
    durationMs: fields.durationMs ?? null,
    memoryKb: fields.memoryKb ?? null,
    provider: fields.provider ?? null,
    providerLabel: fields.providerLabel ?? null,
    attempts: fields.attempts ?? 1,
    warnings: fields.warnings || []
  };
}

function describe(status) {
  switch (status) {
    case STATUS.OK: return 'Finished successfully.';
    case STATUS.COMPILE_ERROR: return 'The program did not compile.';
    case STATUS.RUNTIME_ERROR: return 'The program crashed while running.';
    case STATUS.TIMEOUT: return 'The program was stopped for taking too long.';
    case STATUS.MEMORY: return 'The program ran out of memory.';
    case STATUS.OUTPUT_LIMIT: return 'The program produced too much output.';
    case STATUS.RATE_LIMITED: return 'The execution service is rate limiting us.';
    case STATUS.UNAVAILABLE: return 'The execution service is unavailable.';
    case STATUS.INVALID_REQUEST: return 'The request could not be run.';
    default: return 'The execution service returned an error.';
  }
}

/**
 * A signal number/name -> plain English. Judge0 reports `exit_signal` as an int,
 * Piston as a string, the local runner as a Node signal name; all three land here.
 * Without this a segfault shows up as a blank output box and an exit code of null.
 */
const SIGNALS = {
  4: 'SIGILL', 6: 'SIGABRT', 8: 'SIGFPE', 9: 'SIGKILL', 11: 'SIGSEGV',
  13: 'SIGPIPE', 24: 'SIGXCPU', 25: 'SIGXFSZ'
};

export function signalName(signal) {
  if (signal == null || signal === 0) return null;
  if (typeof signal === 'number') return SIGNALS[signal] || `signal ${signal}`;
  return String(signal);
}

export function signalReason(signal) {
  switch (signalName(signal)) {
    case 'SIGSEGV': return 'Segmentation fault — the program touched memory it does not own (bad pointer, out-of-bounds array, or runaway recursion).';
    case 'SIGABRT': return 'Aborted — the program called abort(), failed an assert, or threw an exception nothing caught.';
    case 'SIGFPE': return 'Arithmetic error — usually integer division or modulo by zero.';
    case 'SIGILL': return 'Illegal instruction — often an integer division by zero the optimiser turned into a trap.';
    case 'SIGKILL': return 'Killed — the program hit a resource limit.';
    case 'SIGXCPU': return 'Killed after exceeding the CPU time limit.';
    case 'SIGXFSZ': return 'Killed after trying to write a file that was too large.';
    case 'SIGPIPE': return 'Killed — wrote to a closed pipe.';
    default: {
      const n = signalName(signal);
      return n ? `Killed by ${n}.` : '';
    }
  }
}

/**
 * Errors an adapter throws. `retryable` drives both the retry loop and the
 * decision to fall through to the next provider, so it must be set honestly:
 * a compile error is NOT retryable, a 503 is.
 */
export class ProviderError extends Error {
  constructor(message, { status = STATUS.PROVIDER_ERROR, retryable = false, cause, httpStatus } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
    if (cause) this.cause = cause;
  }
}
