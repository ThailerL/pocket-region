import { deployFunction } from './deploy.ts';
import { element } from './dom.ts';
import type { LambdaApi } from './modules.ts';
import { run, write } from './terminal.ts';

const handlerSource = element<HTMLTextAreaElement>('#handler');
const deploy = element<HTMLButtonElement>('#deploy');
const invoke = element<HTMLButtonElement>('#invoke');

export function connectHello(lambda: LambdaApi) {
  deploy.addEventListener('click', async () => {
    deploy.disabled = true;
    write('\n# deploying hello\n', 'typed');
    try {
      await deployFunction(lambda, 'hello', handlerSource.value);
      write('deployed.\n');
    } catch (error) {
      write(`deploy failed: ${(error as Error).message}\n`, 'failed');
    } finally {
      deploy.disabled = false;
    }
  });

  // Through the terminal, so the command it runs is shown with its output
  invoke.addEventListener('click', () => run(`lambda invoke --function-name hello --payload '{"name":"tab"}'`));

  deploy.disabled = invoke.disabled = false;
}
