// Node-only test helpers; excluded from the build, since it names devDependencies
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

// A module script in a Node of its own, where nothing but what it starts can keep Node running
export async function runNode(script: string, timeout: number) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'ignore', 'pipe'],
    signal: AbortSignal.timeout(timeout),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const [code] = await once(child, 'exit');
  return { code, stderr };
}

// A region has to be told its port before it mints a queue URL, which is before a server
// over it exists, so the port is claimed and released first
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
