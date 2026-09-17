// The line of the snippet a call or an error came from, read off a stack: the body runs as a function
// the Function constructor made, whose frames V8 marks <anonymous> and SpiderMonkey AsyncFunction,
// while every library frame names a URL
const SNIPPET_FRAME = /(?:<anonymous>|Function):(\d+):\d+/;

const rawLineIn = (stack: string | undefined) => {
  for (const frame of stack?.split('\n') ?? []) {
    const match = SNIPPET_FRAME.exec(frame);
    if (match) return Number(match[1]);
  }
  return undefined;
};

// The constructor puts the body a few lines into the source it makes; measured on a body whose call is on its first line
const offset = (() => {
  let measured: number | undefined;
  new Function('probe', 'probe()')(() => (measured = rawLineIn(new Error().stack)));
  return measured === undefined ? undefined : measured - 1;
})();

export function lineIn(stack: string | undefined): number | undefined {
  const raw = rawLineIn(stack);
  return raw === undefined || offset === undefined ? undefined : raw - offset;
}

export const snippetLine = () => lineIn(new Error().stack);
