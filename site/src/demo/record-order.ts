import { deployFunction, fromButton } from './deploy.ts';
import { element } from './dom.ts';
import RECORD_ORDER from './handlers/record-order.mjs?raw';
import { run } from './terminal.ts';

const ITEMS = ['lamp', 'desk', 'chair', 'plant', 'kettle'];

const deploy = element<HTMLButtonElement>('#deploy-record-order');
const record = element<HTMLButtonElement>('#record-order');
element<HTMLElement>('#record-order-code').textContent = RECORD_ORDER;

export function connectRecordOrder() {
  let orders = 0;

  deploy.addEventListener('click', () =>
    fromButton(deploy, async () => {
      await deployFunction('record-order', RECORD_ORDER);
      await run('s3 mb s3://orders');
    }),
  );

  record.addEventListener('click', () => {
    orders++;
    const payload = { id: String(orders), item: ITEMS[(orders - 1) % ITEMS.length], quantity: 1 + (orders % 3) };
    run(`lambda invoke --function-name record-order --payload '${JSON.stringify(payload)}'`);
  });

  deploy.disabled = record.disabled = false;
}
