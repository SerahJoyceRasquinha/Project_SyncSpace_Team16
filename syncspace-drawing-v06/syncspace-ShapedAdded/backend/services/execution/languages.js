/**
 * The language registry. Adding a language to the IDE = adding one entry here.
 * Nothing else in the execution pipeline knows language names.
 *
 * Each entry describes:
 *   - file(code): the source filename to write (Java needs the public class name)
 *   - compile(file): optional compile step -> { cmd, args, artifacts }
 *   - run(file):     how to execute        -> { cmd, args }
 *   - toolcheck: the binary whose absence means "toolchain not installed"
 *
 * Memory limits are applied per-runtime where the runtime supports it
 * (V8 heap cap, JVM -Xmx) and via POSIX ulimit for native binaries — see
 * runner.js. Windows dev machines fall back to timeout + output caps only.
 */

const JAVA_CLASS_RE = /public\s+(?:final\s+|abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

export const LANGUAGES = {
  javascript: {
    label: 'JavaScript (Node)',
    monaco: 'javascript',
    toolcheck: 'node',
    managed: true, // heap capped by --max-old-space-size, not by ulimit -v
    file: () => 'main.js',
    run: (file) => ({
      cmd: 'node',
      args: ['--max-old-space-size=256', file]
    })
  },

  python: {
    label: 'Python 3',
    monaco: 'python',
    toolcheck: process.platform === 'win32' ? 'python' : 'python3',
    file: () => 'main.py',
    run: (file) => ({
      cmd: process.platform === 'win32' ? 'python' : 'python3',
      args: ['-I', file] // -I: isolated mode (ignores env vars & user site dir)
    })
  },

  c: {
    label: 'C (gcc)',
    monaco: 'c',
    toolcheck: 'gcc',
    file: () => 'main.c',
    compile: (file) => ({
      cmd: 'gcc',
      args: [file, '-O2', '-std=c11', '-o', 'main.out'],
      artifact: 'main.out'
    }),
    run: () => ({
      cmd: process.platform === 'win32' ? 'main.out' : './main.out',
      args: []
    })
  },

  cpp: {
    label: 'C++ (g++)',
    monaco: 'cpp',
    toolcheck: 'g++',
    file: () => 'main.cpp',
    compile: (file) => ({
      cmd: 'g++',
      args: [file, '-O2', '-std=c++17', '-o', 'main.out'],
      artifact: 'main.out'
    }),
    run: () => ({
      cmd: process.platform === 'win32' ? 'main.out' : './main.out',
      args: []
    })
  },

  java: {
    label: 'Java',
    monaco: 'java',
    toolcheck: 'javac',
    managed: true, // heap capped by -Xmx, not by ulimit -v
    // Java insists the filename matches the public class; detect it, default Main.
    file: (code) => {
      const m = JAVA_CLASS_RE.exec(code || '');
      return `${m ? m[1] : 'Main'}.java`;
    },
    compile: (file) => ({
      cmd: 'javac',
      args: [file]
    }),
    run: (file) => ({
      cmd: 'java',
      args: ['-Xmx256m', file.replace(/\.java$/, '')]
    })
  }
};

export const LANGUAGE_IDS = Object.keys(LANGUAGES);
