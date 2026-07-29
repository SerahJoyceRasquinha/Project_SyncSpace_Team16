/**
 * The canonical language registry — the single source of truth for the IDE.
 *
 * Adding a language to SyncSpace means adding ONE entry here. Everything else
 * derives from it: the dropdown, the Monaco grammar, the file extension, the
 * starter template, and the identifier each execution provider expects.
 *
 * The `providers` block is the whole point of this file. Every provider names
 * languages differently — Judge0 uses numeric ids that differ per instance,
 * Piston uses lowercase names plus a version, Paiza uses its own slugs — so the
 * mapping lives here, in data, instead of being smeared across adapters. A new
 * provider is a new key in these blocks, not a new switch statement.
 *
 * Judge0 ids are deliberately expressed as MATCHERS, not hard-coded numbers.
 * `C (GCC 9.2.0)` is id 50 on one Judge0 instance and something else on the
 * next, and hard-coding 50 is the single most common way these integrations
 * break. The adapter fetches GET /languages at runtime and resolves the newest
 * match; `fallbackId` is only used when that call fails.
 */

/** Regexes are anchored on the language family, then the newest version wins. */
export const LANGUAGES = {
  javascript: {
    label: 'JavaScript (Node)',
    monaco: 'javascript',
    extension: '.js',
    filename: 'main.js',
    compiled: false,
    providers: {
      judge0: { match: /^JavaScript\s*\(Node\.js/i, fallbackId: 63 },
      piston: { language: 'javascript' },
      paiza: { language: 'javascript' },
      local: { id: 'javascript' }
    },
    starter: `// SyncSpace IDE — JavaScript (Node)
// Everyone in this room shares this file. Pick a language, hit Run.

const input = require("fs").readFileSync(0, "utf8").trim();
console.log(\`hello, \${input || "world"}\`);
`
  },

  python: {
    label: 'Python 3',
    monaco: 'python',
    extension: '.py',
    filename: 'main.py',
    compiled: false,
    providers: {
      // "Python (3.8.1)" / "Python (3.12.5)" — but NOT "Python (2.7.17)"
      judge0: { match: /^Python\s*\(3\./i, fallbackId: 71 },
      piston: { language: 'python', version: '3' },
      paiza: { language: 'python3' },
      local: { id: 'python' }
    },
    starter: `# SyncSpace IDE — Python 3
import sys

name = sys.stdin.read().strip() or "world"
print(f"hello, {name}")
`
  },

  c: {
    label: 'C (GCC)',
    monaco: 'c',
    extension: '.c',
    filename: 'main.c',
    compiled: true,
    providers: {
      judge0: { match: /^C\s*\(GCC/i, fallbackId: 50 },
      piston: { language: 'c' },
      paiza: { language: 'c' },
      local: { id: 'c' }
    },
    starter: `/* SyncSpace IDE — C (GCC) */
#include <stdio.h>
#include <string.h>

int main(void) {
    char name[64];
    if (!fgets(name, sizeof name, stdin)) name[0] = '\\0';
    name[strcspn(name, "\\r\\n")] = '\\0';
    printf("hello, %s\\n", name[0] ? name : "world");
    return 0;
}
`
  },

  cpp: {
    label: 'C++ (GCC)',
    monaco: 'cpp',
    extension: '.cpp',
    filename: 'main.cpp',
    compiled: true,
    providers: {
      judge0: { match: /^C\+\+\s*\(GCC/i, fallbackId: 54 },
      piston: { language: 'c++' },
      paiza: { language: 'cpp' },
      local: { id: 'cpp' }
    },
    starter: `// SyncSpace IDE — C++ (GCC)
#include <iostream>
#include <string>

int main() {
    std::string name;
    if (!std::getline(std::cin, name) || name.empty()) name = "world";
    std::cout << "hello, " << name << '\\n';
    return 0;
}
`
  },

  java: {
    label: 'Java',
    monaco: 'java',
    extension: '.java',
    filename: 'Main.java',
    compiled: true,
    providers: {
      judge0: { match: /^Java\s*\((OpenJDK|JDK)/i, fallbackId: 62 },
      piston: { language: 'java' },
      paiza: { language: 'java' },
      local: { id: 'java' }
    },
    starter: `// SyncSpace IDE — Java
import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        String name = in.hasNextLine() ? in.nextLine().trim() : "";
        System.out.println("hello, " + (name.isEmpty() ? "world" : name));
    }
}
`
  }
};

export const LANGUAGE_IDS = Object.keys(LANGUAGES);

export const isLanguage = (id) => Object.prototype.hasOwnProperty.call(LANGUAGES, id);

/**
 * Java is the one language where the filename is not arbitrary: `javac` insists
 * the file match the public class. Every remote provider we support compiles a
 * single file whose name it chooses itself, and each expects the public class to
 * be `Main`. Rather than silently failing with "class X is public, should be
 * declared in a file named X.java", we detect the mismatch up front and say so.
 */
const JAVA_PUBLIC_CLASS = /\bpublic\s+(?:final\s+|abstract\s+|strictfp\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/;

function stripNonCode(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

/**
 * Returns a human warning string, or null when the source is fine.
 * A warning, never a hard failure: some providers are more forgiving than
 * others, and guessing wrong should not block a run.
 */
export function preflightWarning(languageId, code) {
  if (languageId !== 'java') return null;
  const cls = JAVA_PUBLIC_CLASS.exec(stripNonCode(code))?.[1];
  if (cls && cls !== 'Main') {
    return `Remote runners compile Java as Main.java, so a public class named "${cls}" will not compile. Rename it to Main (or drop the public modifier).`;
  }
  return null;
}

/**
 * The catalog handed to the frontend. `available` is filled in by the
 * orchestrator once it knows which providers are reachable — the registry
 * itself has no opinion about that.
 */
export function baseCatalog() {
  return LANGUAGE_IDS.map((id) => {
    const l = LANGUAGES[id];
    return {
      id,
      label: l.label,
      monaco: l.monaco,
      extension: l.extension,
      filename: l.filename,
      compiled: l.compiled,
      starter: l.starter
    };
  });
}
