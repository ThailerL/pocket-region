// The parameter a rewritten snippet imports through
export const IMPORT = '__pocketRegionImport';

export const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;

const STATIC =
  /^[ \t]*import\s+(?:([\w$]+)\s*,?\s*)?(?:\*\s*as\s+([\w$]+)|\{([^}]*)\})?\s*(?:from\s*)?(['"])([^'"]+)\4[ \t]*;?/gm;
const DYNAMIC = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

const call = (specifier: string) => `${IMPORT}(${JSON.stringify(specifier)})`;
const load = (specifier: string) => `await ${call(specifier)}`;

function declaration(defaultName: string | undefined, namespace: string | undefined, names: string | undefined, specifier: string) {
  if (namespace) {
    return `const ${namespace} = ${load(specifier)};${defaultName ? ` const ${defaultName} = ${namespace}.default;` : ''}`;
  }
  const bindings = (names ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => name.replace(/\s+as\s+/, ': '));
  if (defaultName) bindings.unshift(`default: ${defaultName}`);
  return bindings.length === 0 ? `${load(specifier)};` : `const { ${bindings.join(', ')} } = ${load(specifier)};`;
}

// Turns a module's imports into awaited calls, so the snippet runs as a function body
export function rewriteImports(code: string): { code: string; specifiers: string[] } {
  const specifiers: string[] = [];
  if (/^[ \t]*export\s/m.test(code)) throw new SyntaxError('a snippet runs as a script body, so it cannot export');

  const rewritten = code
    .replace(STATIC, (match, defaultName, namespace, names, _quote, specifier: string) => {
      specifiers.push(specifier);
      // Kept to the original line count, so errors point at the line shown
      return declaration(defaultName, namespace, names, specifier) + '\n'.repeat(match.split('\n').length - 1);
    })
    .replace(DYNAMIC, (_match, _quote, specifier: string) => {
      specifiers.push(specifier);
      return call(specifier);
    });

  if (/\bimport\s*\(/.test(rewritten)) throw new SyntaxError("only import('a literal specifier') can run in a snippet");
  if (/^[ \t]*import[\s{*'"]/m.test(rewritten)) throw new SyntaxError('an import in this snippet has a form the runner cannot read');
  return { code: rewritten, specifiers };
}
