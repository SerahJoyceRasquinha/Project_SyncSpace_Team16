/**
 * Headless proof of the execution service: real processes, real sandbox rules.
 * Calls executeCode() directly — no HTTP, no auth — because THIS layer's job is
 * running code safely; the route's auth is exercised by test-workspace.mjs.
 *
 *   node test-execute.mjs
 *
 * Note: languages whose toolchain is missing on this machine (e.g. javac on a
 * fresh laptop) must fail GRACEFULLY with a human explanation — that is itself
 * one of the tests, not a skipped case.
 */
import { executeCode, languageCatalog } from './services/execution/index.js';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

console.log('\nSyncSpace — execution service\n');

// 1. the catalog offers all five languages
const cat = languageCatalog();
check('catalog lists 5 languages', cat.length === 5 &&
  ['javascript', 'python', 'java', 'c', 'cpp'].every((id) => cat.some((l) => l.id === id)));

// 2. plain stdout — python
let r = await executeCode({ language: 'python', code: 'print("hello from python")' });
check('python: stdout captured', r.ok && r.stdout.trim() === 'hello from python', JSON.stringify(r));
check('python: exit code 0 + timing reported', r.exitCode === 0 && typeof r.durationMs === 'number');

// 3. stdin round-trip — python
r = await executeCode({
  language: 'python',
  code: 'import sys\nname = sys.stdin.read().strip()\nprint(f"hi {name}")',
  stdin: 'serah'
});
check('python: stdin reaches the program', r.ok && r.stdout.trim() === 'hi serah', r.stdout);

// 4. runtime error -> stderr + non-zero exit, ok:false
r = await executeCode({ language: 'python', code: 'raise ValueError("boom")' });
check('python: runtime error surfaces in stderr', !r.ok && r.exitCode !== 0 && r.stderr.includes('ValueError'));

// 5. javascript with stdin
r = await executeCode({
  language: 'javascript',
  code: 'const s = require("fs").readFileSync(0, "utf8").trim(); console.log("js got: " + s);',
  stdin: '42'
});
check('javascript: runs with stdin', r.ok && r.stdout.trim() === 'js got: 42', JSON.stringify(r));

// 6. C compiles and runs
r = await executeCode({
  language: 'c',
  code: '#include <stdio.h>\nint main(){ int x; if(scanf("%d",&x)==1) printf("double: %d\\n", x*2); return 0; }',
  stdin: '21'
});
check('c: compile + run + stdin', r.ok && r.stdout.trim() === 'double: 42', JSON.stringify(r));

// 7. C compile ERROR lands in compileOutput, phase 'compile'
r = await executeCode({ language: 'c', code: 'int main( { return 0; }' });
check('c: compile error reported as compile phase', !r.ok && r.phase === 'compile' && (r.compileOutput || '').length > 0);

// 8. C++ end-to-end
r = await executeCode({
  language: 'cpp',
  code: '#include <iostream>\nint main(){ std::string s; std::getline(std::cin, s); std::cout << "cpp: " << s << "\\n"; }',
  stdin: 'works'
});
check('cpp: compile + run + stdin', r.ok && r.stdout.trim() === 'cpp: works', JSON.stringify(r));

// 9. infinite loop is killed by the timeout, reported honestly
const t0 = Date.now();
r = await executeCode({ language: 'python', code: 'while True:\n  pass' });
const elapsed = Date.now() - t0;
check('timeout: infinite loop killed', !r.ok && r.timedOut && r.stderr.includes('time limit'), JSON.stringify({ timedOut: r.timedOut }));
check('timeout: killed near the 5s limit, not later', elapsed < 9000, `${elapsed}ms`);

// 10. output flood is truncated, server survives
r = await executeCode({ language: 'python', code: 'print("x" * 100_000_000)' });
check('output cap: flood truncated at 64KB', r.truncated === true && r.stdout.length <= 64 * 1024);

// 11. unknown language rejected cleanly
r = await executeCode({ language: 'brainfudge', code: '+++' });
check('unknown language: clean structured error', !r.ok && r.phase === 'setup' && r.stderr.includes('Supported'));

// 12. empty code rejected cleanly
r = await executeCode({ language: 'python', code: '   ' });
check('empty code: clean structured error', !r.ok && r.phase === 'setup');

// 13. java — on machines without javac this MUST be the friendly toolchain
// message, never a crash; with javac present it must actually run.
r = await executeCode({
  language: 'java',
  code: 'public class Main { public static void main(String[] a){ System.out.println("java ok"); } }'
});
if (r.ok) {
  check('java: compiled and ran', r.stdout.trim() === 'java ok');
  // filename detection: a differently-named public class must still work
  const r2 = await executeCode({
    language: 'java',
    code: 'public class Greeter { public static void main(String[] a){ System.out.println("hi"); } }'
  });
  check('java: public class name detected for filename', r2.ok && r2.stdout.trim() === 'hi', JSON.stringify(r2));
} else {
  check('java: missing toolchain fails gracefully',
    r.phase === 'setup' && /toolchain|not installed/i.test(r.stderr), JSON.stringify(r));
}

// 14. concurrency: 6 parallel runs all complete (queue, no crash)
const burst = await Promise.all(
  Array.from({ length: 6 }, (_, i) =>
    executeCode({ language: 'python', code: `print(${i} * ${i})` }))
);
check('queue: 6 parallel runs all return', burst.every((b, i) => b.ok && b.stdout.trim() === String(i * i)));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
