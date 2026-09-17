import { files } from './files.ts';
import { run } from './terminal.ts';
import { zipOf } from './zip.ts';

const deployed = new Set<string>();

// The first deploy creates the function, a later one replaces its code, as a shell session
// would. The terminal has already shown a failure, so the caller only needs to stop
export async function deployFunction(name: string, source: string, timeout?: number) {
  const zip = `${name}.zip`;
  await files.write(zip, await zipOf('index.mjs', source));
  const verb = deployed.has(name)
    ? 'update-function-code'
    : `create-function --runtime nodejs22.x --handler index.handler --role arn:aws:iam::000000000000:role/lambda${timeout ? ` --timeout ${timeout}` : ''}`;
  const result = await run(`lambda ${verb} --function-name ${name} --zip-file fileb://${zip}`);
  if (result?.code !== 0) throw new Error(`${name} was not deployed`);
  deployed.add(name);
}

// A deploy button's click: held down while its work runs, whatever the outcome
export async function fromButton(button: HTMLButtonElement, work: () => Promise<unknown>) {
  button.disabled = true;
  try {
    await work();
  } catch {
    // Shown in the terminal
  } finally {
    button.disabled = false;
  }
}
