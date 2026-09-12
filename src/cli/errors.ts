export const USAGE = `usage: aws <service> <operation> [--flag value ...]

  Any service with an @aws-sdk/client-<service> package installed; s3api, sqs and dynamodb
  are the ones this is tested against.

Operations and flags are the real AWS CLI's: --kebab-case names the SDK input key, so
--queue-url is QueueUrl. A flag value that looks like JSON is passed as JSON; pass a whole
input document with --cli-input-json instead when a value's type is ambiguous.
`;

// Carries the service it is about, if any, so the reference page can be linked
export class UsageError extends Error {
  service?: string;

  constructor(message: string, service?: string) {
    super(message);
    this.service = service;
  }
}

const referenceUrl = (service: string) =>
  `\noperations and their flags: https://docs.aws.amazon.com/cli/latest/reference/${service}/`;

export function report(error: unknown) {
  if (error instanceof UsageError) {
    const reference = error.service ? referenceUrl(error.service) : '';
    return { stderr: `aws: ${error.message}${reference}\n\n${USAGE}`, code: 2 };
  }
  return { stderr: `aws: ${describe(error)}\n`, code: 1 };
}

// A refused connection is an empty AggregateError; the reason is only in its causes
function describe(error: unknown): string {
  const failure = error as { errors?: unknown[]; name?: string; message?: string };
  if (failure?.errors?.length) return describe(failure.errors[0]);
  const name = failure?.name && failure.name !== 'Error' ? `${failure.name}: ` : '';
  return `${name}${failure?.message || String(error)}`;
}
