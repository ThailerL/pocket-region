// What a host can reach is what it was given, or whatever client it can import: only the
// caller knows which, so neither the list nor the advice can be a constant
export function usageText(services?: string[], note?: string) {
  const available = services
    ? `  services: ${services.join(", ")}\n`
    : `  Any service with an @aws-sdk/client-<service> package installed\n`;
  return `usage: aws <service> <operation> [--flag value ...]

${available}
Operations and flags are the real AWS CLI's: --queue-url names the input's QueueUrl, and a
flag the operation does not take is refused. Each value follows the type the operation gives
that member, so a string is passed as typed, and a list or a structure takes either JSON or
the CLI's shorthand, as in --key-schema AttributeName=id,KeyType=HASH. A whole input document
can go in --cli-input-json. Flags the real CLI reads for itself, such as --region, are
accepted and ignored.
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
