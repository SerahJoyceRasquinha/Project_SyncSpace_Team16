# EXECUTION.md — remote code execution

Code no longer runs on your machine or on the server. It runs in a remote,
sandboxed provider. Nothing in this project now depends on a compiler, SDK,
runtime, PATH entry, Docker install or Visual Studio Build Tools being present
anywhere — on the user's laptop or on the host.

---

## 1. Which provider, and why

I compared the realistic options before writing any code.

| Provider | Status (Jul 2026) | Languages we need | Free tier | Verdict |
| --- | --- | --- | --- | --- |
| **Judge0 CE** | Actively maintained, v1.13.1, open source | all 5 | Sulu: 20k submissions · RapidAPI: 50/day · self-host: unlimited | **Chosen as primary** |
| **Piston** | **Public API closed to new users 15 Feb 2026** | all 5 | Self-host only | Secondary — self-host or granted key |
| paiza.io | Live, `api_key=guest` needs no signup | all 5 | Undocumented, rate limited | Fallback so the app runs unconfigured |
| Sphere Engine | Commercial | all 5 | Trial only | Rejected: paid, heavyweight |
| JDoodle | Commercial | all 5 | 200 credits/day | Rejected: weaker docs, no self-host |

**Piston is not the default, despite being the obvious suggestion.** Its
maintainer closed the public API on 15 February 2026 and states that keys are
*not* issued for "individual projects, portfolio projects, university
assignments, conceptual projects". An MCA project is squarely in that list, so
building on it would mean building on something you cannot get access to. It
remains a first-class adapter for anyone who self-hosts it — one
`docker compose up -d api` — which is genuinely the best option if you want zero
third-party dependency.

**Judge0 won** on documentation quality (a full API reference with every field
and status code specified), result richness (`compile_output` separate from
`stderr`, plus `exit_code`, `exit_signal`, `time`, `memory`), sandbox strength
(cgroups + namespaces via `isolate`), maintenance, and the fact that it offers
a hosted free tier *and* a self-host path, so the project is never trapped.

Every language in the dropdown was verified against every provider, not assumed
— see §6.

---

## 2. Architecture

```
Editor.jsx  ──POST /api/workspaces/:id/execute──▶  executeRoutes.js
                                                        │ auth, rate limit, validation
                                                        ▼
                                            services/execution/index.js
                                              orchestrator: queue, validation,
                                              provider chain, fallback
                                                        │
                        ┌───────────────────────────────┼───────────────────────────────┐
                        ▼                               ▼                               ▼
              providers/judge0.js             providers/piston.js            providers/paiza.js
                        └───────────────────────────────┼───────────────────────────────┘
                                                        ▼
                                              result.js — ONE canonical shape
```

| File | Responsibility |
| --- | --- |
| `languages.js` | The registry. One entry per dropdown language, with the identifier each provider expects. Adding a language is one object. |
| `result.js` | The canonical result shape, output capping, signal wording, `ProviderError`. |
| `http.js` | The only network call: deadlines, jittered retries, redacted logging. |
| `providers/*.js` | One adapter per service. Each exports `{ name, label, configured, hint, languages, execute }`. |
| `providers/index.js` | Registry + chain resolution. |
| `index.js` | Orchestrator. Knows nothing about any specific provider. |

**Adding a provider** = one new file in `providers/` plus one line in
`providers/index.js`. Nothing else changes: routes, orchestrator and UI all
speak the canonical shape. **Switching providers** = one line in `.env`.

### The canonical result

Every adapter must return exactly this. The UI never sees a Judge0
`status.id`, a Piston `signal`, or a Paiza `build_result` — which is precisely
why the output panel is identical for every language and every provider.

```js
{
  ok, phase: 'setup'|'compile'|'run',
  stdout, stderr, compileOutput,
  exitCode, signal, exitReason,
  status: 'ok'|'compile_error'|'runtime_error'|'timeout'|'memory_limit'
        | 'output_limit'|'provider_error'|'rate_limited'|'unavailable'|'invalid_request',
  statusText, timedOut, truncated,
  durationMs, memoryKb,
  provider, providerLabel, attempts, warnings[]
}
```

`makeResult()` builds it, so no adapter can omit a field.

---

## 3. Two decisions worth explaining

**Judge0 language ids are resolved at runtime, never hard-coded.** `C (GCC 9.2.0)`
is id `50` on one instance and something else on the next, and almost every
broken Judge0 integration on GitHub has `50` written into it. The adapter fetches
`GET /languages`, matches on the language family, and takes the newest — which is
also how it avoids picking `Python (2.7.17)` when you asked for Python. The
`fallbackId` in the registry is only used if that call fails.

**Everything is base64.** Judge0's docs warn that GCC emits non-printable bytes
in compile errors, and any program printing emoji or CJK breaks a plain-text
submission. `base64_encoded=true` on both request and response is the only way
Unicode survives intact. Tested with `héllo — ünïcode ✓ 日本語 🎉` in all five
languages.

---

## 4. Failure handling

| Situation | Behaviour |
| --- | --- |
| Compile error | `status: compile_error`, diagnostics in `compileOutput`, phase `compile` |
| Runtime error / crash | `status: runtime_error` with a plain-English signal reason ("Segmentation fault — the program touched memory it does not own…") |
| Infinite loop | Killed by the provider, `status: timeout`, `[stopped: exceeded the time limit]` |
| Large output | Capped at 64 KB per stream by us, on top of whatever the provider does; the UI collapses long blocks behind *show all* and trims to 8 KB before writing into the shared document |
| HTTP 429 | Retried with jittered backoff, then falls through to the next provider |
| HTTP 5xx / network down | Same, and the message says which providers failed and why |
| Malformed response | Rejected rather than parsed into nonsense |
| Host refuses `wait=true` | Detected, falls back to polling |
| All providers down | One readable message listing each provider and its reason — never a crash |

Retries are bounded and only fire on genuinely transient failures. A 4xx that
isn't 429 means the service will reject the request just as firmly next time, so
retrying is pure latency.

---

## 5. Configuration

Everything lives in `backend/.env`, is read only inside adapters, and **never
crosses to the frontend**. The browser receives results; it never receives a key.

```bash
EXEC_PROVIDERS=judge0,piston,paiza     # chain order; first to answer wins

JUDGE0_URL=https://judge0-ce.p.sulu.sh # or RapidAPI, or your own instance
JUDGE0_KEY=your-key

PISTON_URL=http://localhost:2000/api/v2  # only if you self-host
PAIZA_ENABLED=false                      # drop the no-signup fallback

EXEC_RUN_TIMEOUT_MS=8000
EXEC_MEMORY_KB=128000
EXEC_MAX_CONCURRENT=8
EXEC_RATE_MAX=20                        # runs per user per 30s
EXEC_LOG=off                            # structured [exec] logging, on by default
```

With **nothing configured** the app still runs code via paiza.io. That is
deliberate: unzip and it works. It is rate limited and best-effort, so configure
Judge0 for anything that matters — `GET …/execute/providers` shows exactly which
providers are reachable.

`EXEC_PROVIDERS=local` plus `EXEC_ALLOW_LOCAL=true` restores on-server execution
for offline work. It is off by default, labelled unsandboxed in the UI, and
should never be enabled on a deployed server.

---

## 6. Testing

```bash
cd backend
node test-execute.mjs      # 100 checks
```

I cannot reach `judge0.com` or `emkc.org` from where I built this, so the suite
runs against `test-support/mock-execution-api.mjs` — a mock that speaks each
service's **real wire format** and, underneath, genuinely compiles and runs the
submitted program. The adapters are therefore tested against real GCC
diagnostics, real signals, real exit codes and real Unicode rather than canned
fixtures, and the whole thing works in CI with no key and no network.

Covered, per language (all five) **and** per provider (all three):

- runs, and the output proves the *requested* runtime was the one invoked
- stdin, stdin without a trailing newline, multiline stdin
- Unicode and emoji round trip
- compile errors → compile phase with real compiler text
- runtime errors → correct signal and plain-English reason
- non-zero exit codes reported honestly
- 200k-line floods capped, infinite loops timed out
- 10 simultaneous runs from different workspaces stay isolated
- five languages at once, five consecutive runs, no leaked state

Plus fault injection the real APIs can't be asked for on demand: 503 retried,
persistent 429 falling through to the next provider, malformed JSON rejected,
`wait=true` refused → polling path, and a total outage producing one readable
message.

**What I could not test from here:** a live call to a real Judge0 or paiza.io
endpoint. The wire formats are implemented from the official API documentation
(Judge0 CE v1.13.1). Run the suite on your machine with `JUDGE0_URL`/`JUDGE0_KEY`
pointed at a real instance to close that last gap.

---

## 7. What was removed

The old pipeline forked `gcc`, `g++`, `javac`, `python3` and `node` on the
server and sandboxed them with `ulimit` and a temp directory. That is gone from
the default path. With it went the entire class of problems it created: the
missing `-lm` that stopped every C program using `math.h` from linking, the
Windows `main.out` naming and stripped-environment failures, `ulimit -u 64`
starving the JVM of threads, and the "not installed" dropdown entries.

`runner.js` survives only as the engine behind the opt-in `local` provider.
