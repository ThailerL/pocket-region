import { IMPORT } from './imports.ts';

// A module of its own, since WebKit gives a Function constructor's body no position in a stack
export const moduleOf = (body: string) => `export default async function (${IMPORT}, console) {${body}\n}`;

export async function importSnippet(url: string): Promise<(importer: (specifier: string) => Promise<object>, console: object) => Promise<void>> {
  return (await import(/* @vite-ignore */ url)).default;
}

// The line of the snippet a call or an error came from: its frames are the ones naming its module's URL
export function lineIn(stack: string | undefined, url: string): number | undefined {
  for (const frame of stack?.split('\n') ?? []) {
    const position = /^:(\d+):\d+/.exec(frame.split(url)[1] ?? '');
    if (position) return Number(position[1]);
  }
  return undefined;
}
