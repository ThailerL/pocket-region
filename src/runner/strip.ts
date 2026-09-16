import type { transform as SucraseTransform } from 'sucrase';
import { transform } from './sucrase.generated.ts';

// Removes TypeScript's types and keeps every line where it was; plain JavaScript comes back as it was
export function stripTypes(code: string): string {
  // Unused imports stay: in JavaScript, importing a module runs it
  return (transform as typeof SucraseTransform)(code, { transforms: ['typescript'], disableESTransforms: true, keepUnusedImports: true }).code;
}
