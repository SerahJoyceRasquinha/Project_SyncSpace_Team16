# SyncSpace AI

The assistant behind the ✦ AI button. This document covers what it does, why it
is built this way, and what you have to configure to run it.

---

## 1. What was wrong

Two defects were reported. Both were symptoms of the same missing layer: nothing
in the pipeline ever *resolved* anything. It passed fields straight through.

### 1.1 "Give me hello world in Java" returned JavaScript

`AIPage.jsx` had no language state. Every one of its eight action branches
passed the literal string `"javascript"`, and `convert` was hardcoded
`"javascript" → "python"`. That value reached the model as a structured field,
directly under the user's own words:

```
ACTION:
generate

USER REQUEST:
give me the hello world program in java

PROGRAMMING LANGUAGE:
javascript
```

Two contradictory instructions, no priority between them, and the system prompt
(`"Follow the requested programming language"`) pointed at the wrong one. The
model was not malfunctioning — it obeyed the field the prompt told it was
authoritative. That is why the reported answer said *"as specified in the
programming language prompt"*.

### 1.2 Responses took 1–2 minutes

Two independent causes that compounded:

| Cause | Effect |
|---|---|
| `generateContent`, not `generateContentStream` | Time-to-first-character equalled time-to-**last** token. |
| No `thinkingConfig` | `gemini-3.6-flash` defaults to thinking level **`medium`** — hidden reasoning tokens generated before any visible output. On "hello world". |

Serialised, with nothing painted until both finished. Two further multipliers:
`maxOutputTokens` was unset, and the prompts actively requested padding
(`generate` said *"Explain important implementation decisions briefly"* — the
three-paragraph essay attached to a four-line program). Output tokens are the
slowest part of a response, so verbosity is latency.

### 1.3 Raw Markdown on screen

`AIMessage.jsx` rendered `{content}` as a bare string into a `<div>` with
`white-space: pre-wrap`. No parser existed anywhere in the frontend.

### 1.4 Found during the inspection, not reported

- **`POST /api/ai` had no authentication.** The frontend attached a Bearer
  token; the server never read it. Anyone able to reach the port could spend the
  project's Gemini quota, 30 000 characters at a time, without joining a
  workspace. Every other route in this codebase is guarded.
- **No rate limiting**, though `/execute` has it.
- **`/health` checked `OPENAI_API_KEY`** while the service ran on Gemini, so it
  reported "not configured" on a correctly configured server.
- `openai@^7.4.0` is an unused backend dependency.

---

## 2. Architecture

```
AIPage.jsx ──── language state, streaming buffer, cancellation
    │
    ├── AIToolbar.jsx    action tabs + language + target-language selectors
    ├── AIChat.jsx       input, autoscroll, stop button
    └── AIMessage.jsx ── Markdown.jsx ── markdown.js  (parser)
                                       └ highlight.js (tokenizer)
    │
aiApi.js ──── POST /api/ai/stream   (SSE)
    │         POST /api/ai          (buffered fallback)
    ▼
aiRoutes.js ── requireAiAccess → rateLimit → validators.js
    │
request.js ─── resolve language → classify complexity → build prompt
    │              │
    │          languages.js  (registry + deterministic resolution)
    │          prompts.js    (per-action system instructions)
    ▼
aiService.js ── model tiering → thinkingConfig → generateContentStream
```

Each layer has exactly one job, and the two transport paths (streamed and
buffered) share every layer below `aiRoutes.js` — `runAI` is implemented *on top
of* `streamAI`, so the two can never drift apart.

---

## 3. Language resolution

`services/ai/languages.js`. Deterministic, no model call — a regex is both
faster and more reliable than an LLM at reading the word "java".

**Priority order:**

1. **What the user explicitly wrote** — "…in java"
2. **Client metadata** — the language dropdown / the editor's language
3. **Structural inference from attached code**

with one override: when (2) wins but (3) firmly disagrees, (3) takes it. That is
the stale-dropdown case — the editor still says JavaScript because nobody
touched it, while the user has pasted a Java file. Pasted code is evidence; a
dropdown is a leftover.

Two details that matter more than they look:

- **Aliases are matched longest-first.** Scanning `javascript` before `java`
  means the substring can never win. This is the entire defence against the
  reported bug.
- **Word boundaries understand `+` and `#`.** Plain `\b` sits *between* the `c`
  and the `+` in `c++`, so `/\bc\b/` happily matches it and a C++ request
  silently becomes C. The patterns use lookarounds instead.

Conversions read direction from prose (`from`/`to`/`into`/`→`). Two languages
with no directional word is ambiguous, and the module **asks** rather than
guessing — that clarification costs zero provider calls.

The resolved language is injected into the **system** instruction, which
outranks anything in the user turn:

```
OUTPUT LANGUAGE: Java
This is absolute. Every code block must be Java and fenced as ```java.
Never substitute a different language...
```

---

## 4. Model strategy

| Tier | Model | Thinking | Used for |
|---|---|---|---|
| fast | `gemini-3.5-flash-lite` | `minimal` | chat, generate, tests, document |
| smart | `gemini-3.6-flash` | `low` | debug, error, optimize, convert, any payload > 4 kB |

Flash-Lite is not a quality sacrifice for ordinary coding work: per Google's own
launch figures it beats the larger 3 Flash on SWE-Bench Pro (54.2% vs 49.6%),
and it defaults to `minimal` thinking at roughly 350 output tokens/second. The
smart tier uses `low` rather than the model's `medium` default because this is
an interactive assistant, not a batch agent; genuinely deep requests are lifted
back to `medium` by the complexity classifier.

**`temperature`, `top_p` and `top_k` are deliberately never sent.** Google
deprecated them for Gemini 3.x and the API ignores them. Output shape is
controlled through the system instruction and the thinking level instead.

`GEMINI_MODEL` still pins one model across both tiers if you want to A/B a new
one.

---

## 5. Streaming

SSE, not WebSocket: this is a one-way, one-shot text stream over the HTTP
request that started it. No new transport, no socket.io room semantics, no
reconnection state — the existing socket layer is untouched.

Response headers are flushed **before** the provider is called, so the browser's
time-to-first-byte is backend latency (single-digit ms) rather than model
latency. Event types:

| Event | When | Carries |
|---|---|---|
| `meta` | immediately, before the provider call | resolved language, source, model, tier, thinking level |
| `delta` | repeatedly | a text fragment |
| `done` | on success | char count, time-to-first-token, total ms |
| `error` | on failure | sanitized code + message |

Client-side, deltas accumulate in a **ref** and flush to React state once per
`requestAnimationFrame`. A 600-token answer costs ~60 renders instead of ~600,
and the input box never drops keystrokes while an answer streams beside it. The
input is **never disabled** during generation, and `Stop` aborts the fetch,
which closes the socket, which aborts the provider call server-side.

Back-pressure is real: if `res.write` returns `false` the route awaits `drain`
before pulling more from Google, so a slow reader cannot balloon server memory.

---

## 6. Rendering

`markdown.js` + `highlight.js` + `Markdown.jsx`. **Zero new dependencies.**

react-markdown was evaluated first and lost on three counts:

1. **Weight** — unified/remark/mdast/hast is 12+ transitive packages and ~120 kB
   minified, before a highlighter (highlight.js adds ~90 kB gzipped). This app
   already ships Monaco and Konva.
2. **Streaming** — a general parser is built for complete documents. Mid-stream
   the text routinely ends inside an unterminated ``` fence, and a strict parser
   renders that as literal backticks, so every code block flickers as raw text
   until its closing fence arrives. This parser treats an unterminated fence as
   an *open code block*. That property is why a purpose-built parser is the
   better engineering choice here, not merely the lighter one.
3. **Safety** — the parser emits a token tree that the renderer turns into React
   elements. There is no HTML string anywhere, so `dangerouslySetInnerHTML` is
   never needed and raw `<script>` in a model response displays as text.

Monaco was also considered for the code blocks and rejected: it is an *editor*,
and mounting one per block in a transcript costs a model, a view and a layout
pass each — absurd for a five-line Hello World, and it would stutter while
streaming.

Supported: headings, fenced code with language labels and a copy button,
ordered/unordered/nested lists, blockquotes, rules, GFM tables, inline
code/bold/italic/strikethrough/links. Links are restricted to `http(s)` and
`mailto` — a model can emit `javascript:` and a chat bubble is not the place to
find out what it does.

---

## 7. Security

- The API key lives in `backend/.env`, is read only inside `aiService.js`, and
  never crosses the HTTP boundary. **Never put it in a `VITE_` variable** —
  anything so prefixed is compiled into the public frontend bundle.
- `requireAiAccess` accepts a workspace **access** token (membership re-checked
  live against the store, so a removed member loses AI access instantly) or a
  signed-in **user** token. Lobby tickets are rejected.
- Per-identity rate limit: 20 requests/minute by default.
- Field caps: message 8 kB, code 30 kB, error 8 kB, 45 kB combined, inside the
  existing 1 MB body limit.
- Control characters and lone CRs are stripped — a stray `\r` inside a code
  sample can terminate an SSE `data:` line early and desynchronise the client.
- Provider errors are classified by shape, logged in full server-side, and
  reported to the user as a sentence. Google's raw messages can contain request
  URLs, model paths and quota identifiers; none of it reaches the browser.

---

## 8. Testing

```bash
cd backend  && npm run test:ai     # 108 checks
cd frontend && npm run test:ai     #  62 checks
```

The backend suite runs the real route, planner, prompts and SDK against
`test-support/mock-gemini-api.mjs`, which speaks Google's actual wire format
(`:streamGenerateContent?alt=sse`) and models a thinking stall sized by the
requested level. No key, no network, no cost — the only fake is Google itself.

The frontend suite renders components with `react-dom/server` and, notably,
feeds the renderer **every prefix** of a realistic answer one character at a
time, asserting it never throws and never shows a raw fence.

```bash
cd backend && npm run bench:ai     # real latency, needs your key
```

`bench-ai.mjs` measures four configurations — the old buffered/default-thinking
setup through to the new streamed/minimal-thinking fast tier — and reports
time-to-first-character and total time for each, plus whether each produced Java
or JavaScript.

---

## 9. Configuration

Required in `backend/.env`:

```
GEMINI_API_KEY=...
```

Everything else has a working default; see `.env.example` for the full list
(`AI_MODEL_FAST`, `AI_MODEL_SMART`, `AI_THINKING_FAST`, `AI_THINKING_SMART`,
`AI_TIMEOUT_MS`, `AI_STALL_TIMEOUT_MS`, `AI_RATE_MAX`).

**Delete `GEMINI_MODEL=gemini-3.6-flash` from your current `.env`** unless you
specifically want to pin one model — leaving it set disables tiering, so simple
requests keep paying for the heavier model.

---

## 10. Known limits

- **Free-tier rate limits are a wall no code can climb.** If Gemini returns 429,
  the module reports it honestly and stops; it does not silently retry, because
  a retry loop against a rate limit makes latency worse, not better.
- **Cold-start TLS.** The first request after the backend starts pays a
  handshake to Google. The client is a process-wide singleton so this is paid
  once, not per request.
- **`nodemon` restarts drop that warm connection.** Development will feel
  slightly slower than production for the first request after each reload.
- **Conversation history is not sent.** Each request is independent. Follow-up
  questions ("now make it recursive") will not see the previous answer. Adding
  history is a deliberate future decision, not an oversight: it multiplies input
  tokens on every turn, and this module's first priority was latency.
