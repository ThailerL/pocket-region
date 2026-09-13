import { element } from './dom.ts';
import { run } from './terminal.ts';

const EXAMPLES: Record<string, string[]> = {
  S3: [
    's3 mb s3://notes',
    's3api put-object --bucket notes --key hello.txt --body "written in a tab"',
    's3 ls s3://notes',
    's3api get-object --bucket notes --key hello.txt',
  ],
  SQS: ['sqs create-queue --queue-name orders'],
  DynamoDB: ['dynamodb list-tables'],
  SNS: ['sns create-topic --name alerts'],
  Lambda: ['lambda list-functions'],
  CLI: ['help'],
};

const examples = element<HTMLElement>('#examples');

for (const [service, commands] of Object.entries(EXAMPLES)) {
  const label = document.createElement('span');
  label.className = 'service';
  label.textContent = service;
  const row = document.createElement('div');
  row.className = 'examples';
  for (const example of commands) {
    const button = document.createElement('button');
    button.textContent = example.length > 44 ? `${example.slice(0, 43)}…` : example;
    button.title = example;
    button.addEventListener('click', () => run(example));
    row.append(button);
  }
  examples.append(label, row);
}
