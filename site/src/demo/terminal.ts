import { element } from './dom.ts';
import type { Aws } from './modules.ts';

const log = element<HTMLElement>('#log code');
const command = element<HTMLInputElement>('#command');
let aws: Aws | undefined;

export function write(text: string, className?: string) {
  const line = document.createElement('span');
  if (className) line.className = className;
  line.textContent = text;
  log.append(line);
  log.parentElement!.scrollTop = log.parentElement!.scrollHeight;
}

export async function run(line: string) {
  if (!aws || !line.trim()) return;
  command.value = '';
  write(`\n$ aws ${line}\n`, 'typed');
  const { stdout, stderr, code } = await aws(line);
  if (stdout) write(stdout);
  if (stderr) write(stderr, 'failed');
  if (!stdout && !stderr) write(`(exit ${code})\n`);
}

export function connect(cli: Aws) {
  aws = cli;
  command.disabled = false;
  command.focus();
}

element<HTMLFormElement>('#prompt').addEventListener('submit', (event) => {
  event.preventDefault();
  run(command.value);
});
