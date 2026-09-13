import { element } from './dom.ts';
import type { LambdaApi } from './modules.ts';
import { run, write } from './terminal.ts';
import { zipOf } from './zip.ts';

const handlerSource = element<HTMLTextAreaElement>('#handler');
const deploy = element<HTMLButtonElement>('#deploy');
const invoke = element<HTMLButtonElement>('#invoke');

export function connectHello({ sdk, client }: LambdaApi) {
  deploy.addEventListener('click', async () => {
    deploy.disabled = true;
    write('\n# deploying hello\n', 'typed');
    try {
      const ZipFile = await zipOf('index.mjs', handlerSource.value);
      try {
        await client.send(
          new sdk.CreateFunctionCommand({
            FunctionName: 'hello',
            Runtime: 'nodejs22.x',
            Handler: 'index.handler',
            Role: 'arn:aws:iam::000000000000:role/lambda',
            Code: { ZipFile },
          }),
        );
      } catch (error) {
        if (!(error instanceof sdk.ResourceConflictException)) throw error;
        await client.send(new sdk.UpdateFunctionCodeCommand({ FunctionName: 'hello', ZipFile }));
      }
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
