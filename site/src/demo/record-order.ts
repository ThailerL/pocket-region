import { deployFunction } from './deploy.ts';
import { element } from './dom.ts';
import RECORD_ORDER from './handlers/record-order.mjs?raw';
import type { LambdaApi } from './modules.ts';
import { run, write } from './terminal.ts';

const ITEMS = ['lamp', 'desk', 'chair', 'plant', 'kettle'];

const deploy = element<HTMLButtonElement>('#deploy-record-order');
const record = element<HTMLButtonElement>('#record-order');
element<HTMLElement>('#record-order-code').textContent = RECORD_ORDER;

export function connectRecordOrder(lambda: LambdaApi) {
  let orders = 0;

  deploy.addEventListener('click', async () => {
    deploy.disabled = true;
    write('\n# deploying record-order\n', 'typed');
    try {
      await deployFunction(lambda, 'record-order', RECORD_ORDER);
      write('deployed.\n');
      await run('s3 mb s3://orders');
    } catch (error) {
      write(`deploy failed: ${(error as Error).message}\n`, 'failed');
    } finally {
      deploy.disabled = false;
    }
  });

  record.addEventListener('click', () => {
    orders++;
    const payload = { id: String(orders), item: ITEMS[(orders - 1) % ITEMS.length], quantity: 1 + (orders % 3) };
    run(`lambda invoke --function-name record-order --payload '${JSON.stringify(payload)}'`);
  });

  deploy.disabled = record.disabled = false;
}
