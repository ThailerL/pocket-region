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

const asWritten = (specifier: string) => specifier;

// Turns a module's imports into awaited calls of IMPORT, which gets each specifier as resolve
// maps it; specifiers lists them as written
export function rewriteImports(code: string, resolve: (specifier: string) => string = asWritten): { code: string; specifiers: string[] } {
  const specifiers: string[] = [];

  const rewritten = code
    .replace(STATIC, (match, defaultName, namespace, names, _quote, specifier: string) => {
      specifiers.push(specifier);
      // Kept to the original line count, so errors point at the line shown
      return declaration(defaultName, namespace, names, resolve(specifier)) + '\n'.repeat(match.split('\n').length - 1);
    })
    .replace(DYNAMIC, (_match, _quote, specifier: string) => {
      specifiers.push(specifier);
      return call(resolve(specifier));
    });

  if (/\bimport\s*\(/.test(rewritten)) throw new SyntaxError("only import('a literal specifier') can run in a snippet");
  if (/^[ \t]*import[\s{*'"]/m.test(rewritten)) throw new SyntaxError('an import in this snippet has a form the runner cannot read');
  return { code: rewritten, specifiers };
}
