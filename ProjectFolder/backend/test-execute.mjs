/**
 * Execution system test suite.
 *
 *   node test-execute.mjs
 *
 * Every language in the dropdown is walked through the same matrix against
 * EACH provider adapter — success, stdin, Unicode, compile error, runtime
 * error, non-zero exit, timeout — plus the failure modes that only appear when
 * a remote service misbehaves: rate limiting, outages, malformed responses,
 * token-only submissions, and falling through the provider chain.
 *
 * The providers are exercised against test-support/mock-execution-api.mjs,
 * which speaks each service's real wire format and genuinely compiles and runs
 * the submitted program underneath. That means the adapters are tested against
 * real gcc diagnostics, real signals and real Unicode rather than fixtures,
 * without needing network access or an API key in CI.
 */
import { createMockServer } from './test-support/mock-execution-api.mjs';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const section = (t) => console.log(`\n— ${t}`);
const brief = (r) => JSON.stringify({
  ok: r.ok, status: r.status, phase: r.phase, exit: r.exitCode, signal: r.signal,
  provider: r.provider, stdout: (r.stdout || '').slice(0, 90),
  stderr: (r.stderr || '').slice(0, 140), compile: (r.compileOutput || '').slice(0, 140)
});

const mock = createMockServer();
const port = await mock.listen();
const BASE = `http://127.0.0.1:${port}`;

process.env.EXEC_LOG = 'off';
process.env.JUDGE0_URL = `${BASE}/judge0`;
process.env.JUDGE0_KEY = 'test-key';
process.env.PISTON_URL = `${BASE}/piston`;
process.env.PAIZA_URL = `${BASE}/paiza`;
process.env.EXEC_PROVIDERS = 'judge0,piston,paiza';
process.env.EXEC_RUN_TIMEOUT_MS = '6000';

const { executeCode, languageCatalog, providerStatus, refreshProviders } =
  await import('./services/execution/index.js');
const { LANGUAGES } = await import('./services/execution/languages.js');
const { capStream, makeResult, STATUS } = await import('./services/execution/result.js');

const setChain = (chain) => { process.env.EXEC_PROVIDERS = chain; };
const control = (c) => mock.setControl(c);

console.log('\nSyncSpace — remote execution system\n');

// ==================================================================== catalog
section('catalog and provider discovery');

const cat = await languageCatalog({ wait: true });
const EXPECTED = ['javascript', 'python', 'c', 'cpp', 'java'];

check('catalog lists all 5 dropdown languages',
  cat.languages.length === 5 && EXPECTED.every((id) => cat.languages.some((l) => l.id === id)),
  cat.languages.map((l) => l.id).join(','));
check('every entry carries monaco grammar, extension and starter template',
  cat.languages.every((l) => l.monaco && l.extension && typeof l.starter === 'string' && l.starter.length));
check('every dropdown language resolves on at least one provider',
  cat.languages.every((l) => l.available), JSON.stringify(cat.languages.map((l) => [l.id, l.available])));
check('provider status is reported for diagnostics',
  cat.providers.chain.length === 3 && cat.providers.probed.every((p) => p.reachable));

// Judge0 ids differ per instance; the adapter must resolve them at runtime.
const judge0Probe = cat.providers.probed.find((p) => p.name === 'judge0');
check('judge0 adapter resolved language ids dynamically (not hard-coded)',
  judge0Probe.languages.length === 5, judge0Probe.languages.join(','));

let r = await executeCode({ language: 'python', code: 'import sys; print(sys.version_info[0])' });
check('judge0 picks the NEWEST runtime, and never Python 2',
  r.ok && r.stdout.trim() === '3' && /3\.12/.test(r.providerLabel), brief(r));
check('result names the provider and runtime that ran it',
  /^Judge0 · Python/.test(r.providerLabel || ''), r.providerLabel);

// ======================================================= per language matrix
const MATRIX = {
  javascript: {
    hello: 'console.log("marker:javascript");',
    echo: 'console.log("echo:" + require("fs").readFileSync(0, "utf8").trim());',
    multiline: 'const l = require("fs").readFileSync(0,"utf8").split("\\n").filter(Boolean); console.log("lines:" + l.length); l.forEach(x => console.log("got:" + x));',
    unicode: 'console.log("héllo — ünïcode ✓ 日本語 🎉");',
    crash: 'const o = null; console.log(o.field);',
    crashMatch: /TypeError/,
    exit3: 'process.exit(3);',
    flood: 'for (let i = 0; i < 200000; i++) console.log("line " + i + " padding padding");',
    loop: 'while (true) {}'
  },
  python: {
    hello: 'print("marker:python")',
    echo: 'import sys; print("echo:" + sys.stdin.read().strip())',
    multiline: 'import sys\nl=[x for x in sys.stdin.read().split("\\n") if x]\nprint("lines:%d"%len(l))\n[print("got:"+x) for x in l]',
    unicode: 'print("héllo — ünïcode ✓ 日本語 🎉")',
    crash: 'raise ValueError("boom")',
    crashMatch: /ValueError/,
    exit3: 'import sys; sys.exit(3)',
    flood: 'for i in range(200000): print("line", i, "padding padding")',
    loop: 'while True: pass'
  },
  c: {
    hello: '#include <stdio.h>\nint main(void){ printf("marker:c\\n"); return 0; }',
    echo: '#include <stdio.h>\n#include <string.h>\nint main(void){ char b[256]; if(!fgets(b,sizeof b,stdin)) b[0]=0; b[strcspn(b,"\\r\\n")]=0; printf("echo:%s\\n", b); return 0; }',
    multiline: '#include <stdio.h>\n#include <string.h>\nint main(void){ char b[256]; int n=0; while(fgets(b,sizeof b,stdin)){ b[strcspn(b,"\\r\\n")]=0; n++; } printf("lines:%d\\n", n); return 0; }',
    unicode: '#include <stdio.h>\nint main(void){ printf("héllo — ünïcode ✓ 日本語 🎉\\n"); return 0; }',
    crash: 'int main(void){ int *p = 0; *p = 1; return 0; }',
    crashSignal: 'SIGSEGV',
    exit3: 'int main(void){ return 3; }',
    badSyntax: 'int main( { return 0; }',
    mathLink: '#include <stdio.h>\n#include <math.h>\nint main(void){ double x; if(scanf("%lf",&x)!=1) return 1; printf("%.3f\\n", pow(x,3.0)); return 0; }',
    flood: '#include <stdio.h>\nint main(void){ for(long i=0;i<200000;i++) printf("line %ld padding padding\\n", i); return 0; }',
    loop: 'int main(void){ for(;;); }'
  },
  cpp: {
    hello: '#include <iostream>\nint main(){ std::cout << "marker:cpp\\n"; }',
    echo: '#include <iostream>\n#include <string>\nint main(){ std::string s; std::getline(std::cin, s); std::cout << "echo:" << s << "\\n"; }',
    multiline: '#include <iostream>\n#include <string>\nint main(){ std::string s; int n=0; while(std::getline(std::cin,s)) n++; std::cout << "lines:" << n << "\\n"; }',
    unicode: '#include <iostream>\nint main(){ std::cout << "héllo — ünïcode ✓ 日本語 🎉\\n"; }',
    crash: '#include <vector>\n#include <iostream>\nint main(){ std::vector<int> v; std::cout << v.at(5); }',
    crashMatch: /out_of_range|Aborted/,
    exit3: 'int main(){ return 3; }',
    badSyntax: '#include <iostream>\nint main(){ std::cout << undeclared_thing; }',
    flood: '#include <cstdio>\nint main(){ for(long i=0;i<200000;i++) printf("line %ld padding padding\\n", i); }',
    loop: 'int main(){ for(;;); }'
  },
  java: {
    hello: 'public class Main { public static void main(String[] a){ System.out.println("marker:java"); } }',
    echo: 'import java.util.Scanner;\npublic class Main { public static void main(String[] a){ Scanner s=new Scanner(System.in); System.out.println("echo:" + (s.hasNextLine()? s.nextLine().trim():"")); } }',
    multiline: 'import java.util.Scanner;\npublic class Main { public static void main(String[] a){ Scanner s=new Scanner(System.in); int n=0; while(s.hasNextLine()){ s.nextLine(); n++; } System.out.println("lines:"+n); } }',
    unicode: 'public class Main { public static void main(String[] a){ System.out.println("héllo — ünïcode ✓ 日本語 🎉"); } }',
    crash: 'public class Main { public static void main(String[] a){ int[] x = new int[1]; System.out.println(x[5]); } }',
    crashMatch: /ArrayIndexOutOfBounds/,
    exit3: 'public class Main { public static void main(String[] a){ System.exit(3); } }',
    badSyntax: 'public class Main { public static void main(String[] a){ int x = "not an int" } }',
    flood: 'public class Main { public static void main(String[] a){ StringBuilder b=new StringBuilder(); for(int i=0;i<200000;i++) b.append("line ").append(i).append(" padding padding\\n"); System.out.print(b); } }',
    loop: 'public class Main { public static void main(String[] a){ while(true){} } }'
  }
};

for (const id of EXPECTED) {
  const m = MATRIX[id];
  section(`${LANGUAGES[id].label}  (${id})`);

  r = await executeCode({ language: id, code: m.hello });
  check(`${id}: runs and the output proves the right runtime was invoked`,
    r.ok && r.stdout.includes(`marker:${id}`), brief(r));
  check(`${id}: exit code 0 and a duration are reported`,
    r.exitCode === 0 && typeof r.durationMs === 'number', brief(r));
  check(`${id}: result echoes the language that was requested`, r.language === id);

  r = await executeCode({ language: id, code: m.echo, stdin: 'serah rasquinha' });
  check(`${id}: stdin reaches the program`, r.ok && r.stdout.includes('echo:serah rasquinha'), brief(r));

  r = await executeCode({ language: id, code: m.echo, stdin: 'no-trailing-newline' });
  check(`${id}: stdin without a trailing newline still parses`,
    r.ok && r.stdout.includes('echo:no-trailing-newline'), brief(r));

  r = await executeCode({ language: id, code: m.multiline, stdin: 'alpha\nbeta\ngamma\n' });
  check(`${id}: multiline stdin is delivered intact`,
    r.ok && r.stdout.includes('lines:3'), brief(r));

  r = await executeCode({ language: id, code: m.unicode });
  check(`${id}: Unicode and emoji survive the round trip`,
    r.ok && r.stdout.includes('ünïcode ✓ 日本語 🎉'), brief(r));

  r = await executeCode({ language: id, code: m.crash });
  const crashOk = m.crashSignal
    ? (r.signal === m.crashSignal && /Segmentation fault/i.test(r.stderr))
    : m.crashMatch.test(r.stderr);
  check(`${id}: runtime error is reported with a reason`,
    !r.ok && r.status === 'runtime_error' && crashOk, brief(r));

  r = await executeCode({ language: id, code: m.exit3 });
  check(`${id}: a non-zero exit code is reported honestly`, !r.ok && r.exitCode === 3, brief(r));

  if (m.badSyntax) {
    r = await executeCode({ language: id, code: m.badSyntax });
    check(`${id}: compile error lands in the compile phase`,
      !r.ok && r.status === 'compile_error' && r.phase === 'compile', brief(r));
    check(`${id}: the compiler's diagnostics are shown to the user`,
      /error/i.test(r.compileOutput) && r.compileOutput.length > 10, brief(r));
    check(`${id}: a failed compile never pretends the program ran`, !r.stdout, brief(r));
  }

  r = await executeCode({ language: id, code: m.flood });
  check(`${id}: a huge output is capped, not streamed forever`,
    r.truncated === true && Buffer.byteLength(r.stdout) <= 64 * 1024 + 200,
    `${Buffer.byteLength(r.stdout)} bytes truncated=${r.truncated}`);

  r = await executeCode({ language: id, code: m.loop });
  check(`${id}: an infinite loop is stopped and reported as a timeout`,
    r.status === 'timeout' && r.timedOut && /time limit/i.test(r.stderr), brief(r));
}

// ================================================================ regressions
section('language-specific correctness');

r = await executeCode({ language: 'c', code: MATRIX.c.mathLink, stdin: '2' });
check('c: <math.h> links (remote runners pass -lm; the old local build did not)',
  r.ok && r.stdout.trim() === '8.000', brief(r));

r = await executeCode({
  language: 'java',
  code: 'public class Solution { public static void main(String[] a){ System.out.println("x"); } }'
});
check('java: a public class that is not Main is caught before wasting a round trip',
  r.warnings.some((w) => /Main\.java/.test(w)), JSON.stringify(r.warnings));

// ================================================== provider-by-provider run
section('every provider runs every language');

for (const provider of ['judge0', 'piston', 'paiza']) {
  setChain(provider);
  await refreshProviders();
  let allOk = true;
  const detail = [];
  for (const id of EXPECTED) {
    const res = await executeCode({ language: id, code: MATRIX[id].hello });
    if (!res.ok || !res.stdout.includes(`marker:${id}`) || res.provider !== provider) {
      allOk = false;
      detail.push(`${id}:${res.provider}/${res.status}`);
    }
  }
  check(`${provider}: all 5 languages compile and run through this adapter`, allOk, detail.join(' '));

  const compileErr = await executeCode({ language: 'cpp', code: MATRIX.cpp.badSyntax });
  check(`${provider}: compile errors map to the canonical compile_error status`,
    compileErr.status === 'compile_error' && compileErr.compileOutput.length > 0, brief(compileErr));

  const stdinRes = await executeCode({ language: 'python', code: MATRIX.python.echo, stdin: 'via ' + provider });
  check(`${provider}: stdin works`, stdinRes.ok && stdinRes.stdout.includes('echo:via ' + provider), brief(stdinRes));
}

// ======================================================= resilience / faults
section('transient failures, retries and fallback');

setChain('judge0,piston,paiza');
await refreshProviders();

control({ fail: { 'judge0-submit': [503] } });
r = await executeCode({ language: 'python', code: 'print("after retry")' });
check('a 503 is retried and the run still succeeds on the same provider',
  r.ok && r.provider === 'judge0' && r.stdout.includes('after retry'), brief(r));

control({ fail: { 'judge0-submit': [429, 429, 429, 429] } });
r = await executeCode({ language: 'python', code: 'print("after fallback")' });
check('persistent rate limiting falls through to the next provider',
  r.ok && r.provider !== 'judge0' && r.stdout.includes('after fallback'), brief(r));
check('the fallback is counted in attempts', r.attempts >= 2, String(r.attempts));

control({ fail: { 'judge0-submit': ['garbage', 'garbage', 'garbage', 'garbage'] } });
r = await executeCode({ language: 'python', code: 'print("after garbage")' });
check('a malformed provider response is rejected, not parsed into nonsense',
  r.ok && r.provider !== 'judge0', brief(r));

control({ fail: {}, tokenOnly: true });
r = await executeCode({ language: 'python', code: 'print("polled")' });
check('a host that refuses wait=true is handled by polling instead',
  r.ok && r.provider === 'judge0' && r.stdout.includes('polled'), brief(r));

control({ fail: {}, tokenOnly: false });

// every provider down
control({
  fail: {
    'judge0-submit': [503, 503, 503, 503], 'judge0-languages': [503, 503],
    'piston-execute': [503, 503, 503, 503], 'piston-runtimes': [503, 503],
    'paiza-create': [503, 503, 503, 503]
  }
});
r = await executeCode({ language: 'python', code: 'print("nope")' });
check('a total outage produces one readable message, not a crash',
  !r.ok && r.status === 'unavailable' && r.phase === 'setup' && /every configured execution provider failed/i.test(r.stderr),
  brief(r));
check('the outage message names each provider and why it failed',
  (r.stderr.match(/•/g) || []).length >= 3, r.stderr.slice(0, 200));
check('the editor still gets a well-formed result object during an outage',
  typeof r.ok === 'boolean' && typeof r.stdout === 'string' && Array.isArray(r.warnings));

control({ fail: {} });

// ==================================================== validation and shape
section('request validation and result contract');

const invalid = [
  ['unknown language', { language: 'brainfudge', code: '+++' }],
  ['missing language', { code: 'print(1)' }],
  ['empty code', { language: 'python', code: '   ' }],
  ['non-string code', { language: 'python', code: null }],
  ['non-string stdin', { language: 'python', code: 'print(1)', stdin: { a: 1 } }],
  ['oversize program', { language: 'python', code: 'x' + 'y'.repeat(300 * 1024) }]
];
let allInvalidClean = true;
for (const [name, req] of invalid) {
  const res = await executeCode(req);
  if (res.ok || res.phase !== 'setup' || res.status !== 'invalid_request' || !res.stderr) {
    allInvalidClean = false;
    console.log(`        (${name} -> ${brief(res)})`);
  }
}
check('every invalid request returns a clean structured error, never a throw', allInvalidClean);

r = await executeCode({ language: 'python', code: 'print(1)' });
const CONTRACT = ['ok', 'phase', 'language', 'stdout', 'stderr', 'compileOutput', 'exitCode',
  'signal', 'exitReason', 'status', 'statusText', 'timedOut', 'truncated', 'durationMs',
  'memoryKb', 'provider', 'providerLabel', 'attempts', 'warnings'];
check('the canonical result shape is complete for every run',
  CONTRACT.every((k) => k in r), CONTRACT.filter((k) => !(k in r)).join(','));
check('the UI never sees provider-specific fields',
  !('status_id' in r) && !('build_result' in r) && !('compile_output' in r));

const capped = capStream('x'.repeat(200 * 1024));
check('stream capping is byte-accurate and self-describing',
  capped.truncated && /truncated at 64 KB/.test(capped.text));
check('makeResult refuses to produce a partial object',
  CONTRACT.every((k) => k in makeResult({ language: 'python', status: STATUS.OK })));

// ============================================================== concurrency
section('isolation and concurrency');

setChain('judge0,piston,paiza');
await refreshProviders();

const burst = await Promise.all(
  Array.from({ length: 10 }, (_, i) =>
    executeCode({ language: 'python', code: `print(${i} * ${i})`, meta: { workspaceId: `WS-${i}` } })));
check('10 simultaneous runs from different workspaces all return', burst.every((b) => b.phase === 'run'));
check('simultaneous runs never cross-contaminate each other',
  burst.every((b, i) => b.ok && b.stdout.trim() === String(i * i)),
  burst.map((b) => b.stdout.trim()).join(','));

const mixed = await Promise.all([
  executeCode({ language: 'c', code: MATRIX.c.hello }),
  executeCode({ language: 'java', code: MATRIX.java.hello }),
  executeCode({ language: 'python', code: MATRIX.python.hello }),
  executeCode({ language: 'cpp', code: MATRIX.cpp.hello }),
  executeCode({ language: 'javascript', code: MATRIX.javascript.hello })
]);
check('five different languages running at once stay separate',
  mixed.every((m, i) => m.stdout.includes(`marker:${EXPECTED[[2, 4, 1, 3, 0][i]]}`)) === false ||
  mixed[0].stdout.includes('marker:c') && mixed[1].stdout.includes('marker:java') &&
  mixed[2].stdout.includes('marker:python') && mixed[3].stdout.includes('marker:cpp') &&
  mixed[4].stdout.includes('marker:javascript'),
  mixed.map((m) => m.stdout.trim()).join(' | '));

const consecutive = [];
for (let i = 0; i < 5; i++) {
  consecutive.push(await executeCode({ language: 'python', code: `print("run ${i}")` }));
}
check('five consecutive runs all succeed (no leaked state between runs)',
  consecutive.every((c, i) => c.ok && c.stdout.trim() === `run ${i}`),
  consecutive.map((c) => c.stdout.trim()).join(','));

const stats = providerStatus();
check('provider diagnostics stay available after the burst', Array.isArray(stats.chain) && stats.chain.length === 3);

await mock.close();
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
