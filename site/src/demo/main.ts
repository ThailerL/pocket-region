import { element } from './dom.ts';
import './examples.ts';
import './tabs.ts';
import { connectHashing } from './hashing.ts';
import { connectHello } from './hello.ts';
import { loadModules } from './modules.ts';
import { connectRecordOrder } from './record-order.ts';
import { connect, write } from './terminal.ts';

const status = element<HTMLElement>('#status');
const examples = element<HTMLElement>('#examples');

async function boot() {
  status.replaceChildren();
  try {
    const started = performance.now();
    const [browser, lambdaSdk] = await loadModules();
    const region = await browser.createRegion();
    const lambda = {
      sdk: lambdaSdk,
      client: new lambdaSdk.LambdaClient({
        region: 'us-east-1',
        endpoint: 'http://localhost:4566',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        requestHandler: browser.requestHandler(region),
      }),
    };
    write(`ready in ${Math.round(performance.now() - started)} ms. Try a command.\n`);
    for (const button of examples.querySelectorAll('button')) button.disabled = false;
    connectRecordOrder(lambda);
    connectHello(lambda);
    connectHashing(lambda);
    connect(browser.awsCli(region));
  } catch (error) {
    write(`failed to boot: ${(error as Error).message}\n`, 'failed');
    const retry = document.createElement('button');
    retry.textContent = 'Try again';
    retry.addEventListener('click', boot);
    status.append(retry);
  }
}

boot();
