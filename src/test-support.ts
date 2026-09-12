// Shared by the test files; excluded from the build, since it names devDependencies
import net from 'node:net';

// Every client points at the same place with the same throwaway credentials: only the
// transport differs, so only that belongs at the call site
export const clientConfig = (extra: object = {}) => ({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  ...extra,
});

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
