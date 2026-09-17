import { deployFunction, fromButton } from './deploy.ts';
import { element } from './dom.ts';
import { run } from './terminal.ts';

const handlerSource = element<HTMLTextAreaElement>('#handler');
const deploy = element<HTMLButtonElement>('#deploy');
const invoke = element<HTMLButtonElement>('#invoke');

export function connectHello() {
  deploy.addEventListener('click', () => fromButton(deploy, () => deployFunction('hello', handlerSource.value)));
  invoke.addEventListener('click', () => run(`lambda invoke --function-name hello --payload '{"name":"tab"}'`));
  deploy.disabled = invoke.disabled = false;
}
