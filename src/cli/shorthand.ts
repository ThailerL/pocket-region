import { UsageError } from './errors.ts';
import { elementOf, flagKey, kindOf, membersFrom, type MemberKind } from './schema.ts';

// The real CLI's shorthand for a value that holds other values:
// AttributeName=id,AttributeType=S, with {…} around a nested structure and […] around a
// nested list
type Raw = string | Raw[] | { [key: string]: Raw };

type Cursor = { text: string; at: number };

// Where the value came from, so a failure names the flag the reader typed
export type Where = { flag: string; service: string };

export function fromShorthand(text: string, schema: unknown, where: Where): unknown {
  return shaped(parse(text, where), schema, where, '');
}

function parse(text: string, where: Where): Raw {
  // A value that assigns nothing is a value: --attribute-names All is one name, not a pair
  if (!text.startsWith('{') && !text.startsWith('[') && !/^[^=,{}[\]]+=/.test(text)) return text;
  const cursor = { text, at: 0 };
  const value =
    text.startsWith('{') || text.startsWith('[')
      ? readValue(cursor, where)
      : readPairs(cursor, '', where);
  if (cursor.at < text.length) throw fault(where, `unexpected "${text.slice(cursor.at)}"`);
  return value;
}

function readValue(cursor: Cursor, where: Where): Raw {
  const character = cursor.text[cursor.at];
  if (character === '{') return readPairs(step(cursor), '}', where);
  if (character === '[') return readItems(step(cursor), where);
  return readScalar(cursor, ',}]', where);
}

function readPairs(cursor: Cursor, closing: string, where: Where) {
  const pairs: Record<string, Raw> = {};
  while (cursor.at < cursor.text.length && cursor.text[cursor.at] !== closing) {
    const key = readScalar(cursor, '=,}]', where);
    if (cursor.text[cursor.at] !== '=') throw fault(where, `expected "${key}=value"`);
    pairs[key] = readValue(step(cursor), where);
    if (cursor.text[cursor.at] === ',') step(cursor);
  }
  if (closing) close(cursor, closing, where);
  return pairs;
}

function readItems(cursor: Cursor, where: Where) {
  const items: Raw[] = [];
  while (cursor.at < cursor.text.length && cursor.text[cursor.at] !== ']') {
    items.push(readValue(cursor, where));
    if (cursor.text[cursor.at] === ',') step(cursor);
  }
  close(cursor, ']', where);
  return items;
}

// A quoted scalar holds whatever it was given, commas included
function readScalar(cursor: Cursor, stops: string, where: Where) {
  if (cursor.text[cursor.at] === '"') {
    const end = cursor.text.indexOf('"', cursor.at + 1);
    if (end === -1) throw fault(where, 'a quote is left open');
    const quoted = cursor.text.slice(cursor.at + 1, end);
    cursor.at = end + 1;
    return quoted;
  }
  const from = cursor.at;
  while (cursor.at < cursor.text.length && !stops.includes(cursor.text[cursor.at] as string)) {
    cursor.at += 1;
  }
  return cursor.text.slice(from, cursor.at);
}

const step = (cursor: Cursor) => {
  cursor.at += 1;
  return cursor;
};

function close(cursor: Cursor, closing: string, where: Where) {
  if (cursor.text[cursor.at] !== closing) throw fault(where, `expected "${closing}"`);
  cursor.at += 1;
}

function shaped(raw: Raw, schema: unknown, where: Where, path: string): unknown {
  const kind = kindOf(schema);
  if (kind === 'structure') return structure(raw, schema, where, path);
  if (kind === 'map') return map(raw, schema, where, path);
  // A list written without brackets is one element, which is how a single tag is given
  if (kind === 'list') {
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map((item, index) => shaped(item, elementOf(schema), where, `${path}[${index}]`));
  }
  if (typeof raw !== 'string') throw fault(where, `${at(path)}takes one value`);
  return scalar(raw, kind, where, path);
}

function structure(raw: Raw, schema: unknown, where: Where, path: string) {
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw fault(where, `${at(path)}takes Key=value pairs`);
  }
  const members = membersFrom(schema);
  const shape: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const member = members?.get(flagKey(key));
    if (!member) throw unknownKey(key, members, where, path);
    shape[member.name] = shaped(value, member.schema, where, `${path}.${member.name}`);
  }
  return shape;
}

function map(raw: Raw, schema: unknown, where: Where, path: string) {
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw fault(where, `${at(path)}takes Key=value pairs`);
  }
  const shape: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    shape[key] = shaped(value, elementOf(schema), where, `${path}.${key}`);
  }
  return shape;
}

// Also the top level's rule, so --read-capacity-units and ReadCapacityUnits= inside shorthand
// answer a bad number the same way
export function scalar(raw: string, kind: MemberKind | undefined, where: Where, path = '') {
  if (kind === 'number') {
    const number = Number(raw);
    if (raw.trim() === '' || Number.isNaN(number)) {
      throw fault(where, `${at(path)}takes a number, not "${raw}"`);
    }
    return number;
  }
  if (kind === 'boolean') {
    if (raw !== 'true' && raw !== 'false') {
      throw fault(where, `${at(path)}takes true or false, not "${raw}"`);
    }
    return raw === 'true';
  }
  return raw;
}

const at = (path: string) => (path ? `${path.replace(/^\./, '')} ` : '');

function unknownKey(
  key: string,
  members: ReturnType<typeof membersFrom>,
  where: Where,
  path: string,
) {
  const known = members ? [...members.values()].map((member) => member.name).join(', ') : '';
  return fault(where, `${at(path)}has no "${key}"${known ? `, only ${known}` : ''}`);
}

const fault = ({ flag, service }: Where, message: string) =>
  new UsageError(`--${flag}: ${message}`, service);
