// The console a snippet sees, turning each call into a line of output
import type { ConsoleMethod, RunnerOutput } from './protocol.ts';

export function format(value: unknown, indent = 2) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value, null, indent) ?? String(value);
  } catch {
    return String(value);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

// Laid out as Node's console.table does, for a page that only shows text
function tableText(entries: [string, unknown][], properties: unknown) {
  const rows = entries.map(([index, row]) => ({ index, row, record: isRecord(row) ? row : undefined }));
  const columns = Array.isArray(properties)
    ? properties.map(String)
    : [...new Set(rows.flatMap(({ record }) => (record ? Object.keys(record) : [])))];
  const hasValues = rows.some(({ record }) => !record);
  const cell = (value: unknown) => format(value, 0);

  const header = ['(index)', ...columns, ...(hasValues ? ['Values'] : [])];
  const body = rows.map(({ index, row, record }) => [
    index,
    ...columns.map((column) => (record && column in record ? cell(record[column]) : '')),
    ...(hasValues ? [record ? '' : cell(row)] : []),
  ]);
  const widths = header.map((name, i) => Math.max(name.length, ...body.map((cells) => cells[i].length)));
  const rule = (left: string, middle: string, right: string) => left + widths.map((width) => '─'.repeat(width + 2)).join(middle) + right;
  const line = (cells: string[]) => `│${cells.map((text, i) => ` ${text.padEnd(widths[i])} `).join('│')}│`;
  return [rule('┌', '┬', '┐'), line(header), rule('├', '┼', '┤'), ...body.map(line), rule('└', '┴', '┘')].join('\n');
}

function textOf(method: ConsoleMethod, args: unknown[]) {
  // A table with no rows to draw (a string, an Error, a Map) prints as log would
  const entries = method === 'table' && isRecord(args[0]) ? Object.entries(args[0]) : [];
  if (entries.length > 0) return tableText(entries, args[1]);
  if (method === 'dir') return format(args[0]);
  return args.map((value) => format(value)).join(' ');
}

export function createConsole(write: (output: RunnerOutput) => void): Record<ConsoleMethod, (...args: unknown[]) => void> {
  const call = (method: ConsoleMethod) => (...args: unknown[]) =>
    write({ method, stream: method === 'warn' || method === 'error' ? 'error' : 'log', text: textOf(method, args), values: args });
  return { log: call('log'), info: call('info'), debug: call('debug'), table: call('table'), dir: call('dir'), warn: call('warn'), error: call('error') };
}
