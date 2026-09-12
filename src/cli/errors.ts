// What a host can reach is what it was given, or whatever client it can import: only the
// caller knows which, so neither the list nor the advice can be a constant
export function usageText(services?: string[], note?: string) {
  const available = services
    ? `  services: ${services.join(", ")}\n`
    : `  Any service with an @aws-sdk/client-<service> package installed\n`;
  return `usage: aws <service> <operation> [--flag value ...]

${available}
Operations and flags are the real AWS CLI's: --kebab-case names the SDK input key, so
--queue-url is QueueUrl. A flag value that looks like JSON is passed as JSON; pass a whole
input document with --cli-input-json instead when a value's type is ambiguous.
${note ? `\n${note}\n` : ""}`;
}

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

export function report(error: unknown, usage: string) {
  if (error instanceof UsageError) {
    const reference = error.service ? referenceUrl(error.service) : "";
    return { stderr: `aws: ${error.message}${reference}\n\n${usage}`, code: 2 };
  }
  return { stderr: `aws: ${describe(error)}\n`, code: 1 };
}

// A refused connection is an empty AggregateError; the reason is only in its causes
function describe(error: unknown): string {
  const failure = error as {
    errors?: unknown[];
    name?: string;
    message?: string;
  };
  if (failure?.errors?.length) return describe(failure.errors[0]);
  const name =
    failure?.name && failure.name !== "Error" ? `${failure.name}: ` : "";
  return `${name}${failure?.message || String(error)}`;
}
