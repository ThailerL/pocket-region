import { deployFunction } from './deploy.ts';
import { element } from './dom.ts';
import HASH_HANDLER from './handlers/hash-password.mjs?raw';
import type { LambdaApi } from './modules.ts';
import { write } from './terminal.ts';

const PASSWORDS = ['hunter2', 'correct horse battery staple', 'letmein', 'tr0ub4dor&3', 'swordfish'];

type Hashed = { password: string; environment: string; hash: string; started: number; finished: number };

const hashOne = element<HTMLButtonElement>('#hash-one');
const burst = element<HTMLButtonElement>('#burst');
element<HTMLElement>('#hash-code').textContent = HASH_HANDLER;

export function connectHashing(lambda: LambdaApi) {
  const { sdk, client } = lambda;
  let created: Promise<void> | undefined;

  // Deployed once, the first time a button is pressed. A machine with fewer cores than
  // passwords runs some of them in turn, hence the timeout
  const createHashFunction = () => deployFunction(lambda, 'hash-password', HASH_HANDLER, 30);

  async function hash(password: string): Promise<Hashed> {
    const { Payload, FunctionError } = await client.send(
      new sdk.InvokeCommand({ FunctionName: 'hash-password', Payload: JSON.stringify({ password }) }),
    );
    const body = JSON.parse(new TextDecoder().decode(Payload));
    if (FunctionError) throw new Error(body.errorMessage);
    return { password, ...body };
  }

  async function hashPasswords(passwords: string[]) {
    hashOne.disabled = burst.disabled = true;
    write(passwords.length === 1 ? '\n# hashing 1 password\n' : `\n# hashing ${passwords.length} passwords at once\n`, 'typed');
    try {
      await (created ??= createHashFunction());
      const started = Date.now();
      const results = await Promise.all(passwords.map(hash));
      const total = (Date.now() - started) / 1000;
      if (results.length === 1) {
        write(`1 hash in ${total.toFixed(2)} s\n`);
      } else {
        const inTurn = results.reduce((sum, { started: began, finished }) => sum + finished - began, 0) / 1000;
        write(`${results.length} hashes in ${total.toFixed(2)} s (one at a time would take ${inTurn.toFixed(2)} s)\n`);
      }
      for (const { password, hash, environment, started: began, finished } of results) {
        write(`  ${hash}  ${password.padEnd(30)}environment ${environment}  +${began - started}–${finished - started} ms\n`);
      }
    } catch (error) {
      created = undefined;
      write(`hashing failed: ${(error as Error).message}\n`, 'failed');
    } finally {
      hashOne.disabled = burst.disabled = false;
    }
  }

  hashOne.addEventListener('click', () => hashPasswords(PASSWORDS.slice(0, 1)));
  burst.addEventListener('click', () => hashPasswords(PASSWORDS));
  hashOne.disabled = burst.disabled = false;
}
