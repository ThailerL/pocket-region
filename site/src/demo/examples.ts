import { element } from './dom.ts';
import { run } from './terminal.ts';

const EXAMPLES: Record<string, string[]> = {
  S3: [
    's3 mb s3://notes',
    's3api put-object --bucket notes --key hello.txt --body "written in a tab"',
    's3 ls s3://notes',
    's3api get-object --bucket notes --key hello.txt',
  ],
  SQS: [
    'sqs create-queue --queue-name tasks',
    'sqs send-message --queue-url http://localhost:4566/000000000000/tasks --message-body "sent from a tab"',
    'sqs receive-message --queue-url http://localhost:4566/000000000000/tasks',
  ],
  DynamoDB: [
    'dynamodb create-table --table-name notes --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST',
    'dynamodb put-item --table-name notes --item \'{"id":{"S":"1"},"text":{"S":"written in a tab"}}\'',
    'dynamodb scan --table-name notes',
  ],
  SNS: [
    'sns create-topic --name alerts',
    'sns subscribe --topic-arn arn:aws:sns:us-east-1:000000000000:alerts --protocol sqs --notification-endpoint arn:aws:sqs:us-east-1:000000000000:tasks',
    'sns publish --topic-arn arn:aws:sns:us-east-1:000000000000:alerts --message "disk is 90% full"',
    'sqs receive-message --queue-url http://localhost:4566/000000000000/tasks',
  ],
  Lambda: [
    'lambda list-functions',
    'lambda invoke --function-name record-order --payload \'{"id":"9","item":"lamp","quantity":1}\'',
  ],
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
