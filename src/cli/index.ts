import type { Dispatcher } from '../core.ts';
import { parseArgs, tokenize } from './args.ts';
import { clientsFor, dispatch } from './dispatch.ts';
import { report, USAGE } from './errors.ts';
import { runS3Verb, type Files } from './s3-verbs.ts';

export type { Files } from './s3-verbs.ts';

export type CliResult = { stdout: string; stderr: string; code: number };

export type AwsCliOptions = {
  // A non-zero exit becomes a rejection, which is what a test wants and a terminal does not
  throwOnError?: boolean;
  // Where `s3 cp` reads and writes local paths; Node finds its own, a page has none
  files?: Files;
};

export class CliError extends Error {
  result: CliResult;

  constructor(result: CliResult) {
    super(result.stderr.trim());
    this.result = result;
  }
}

// The AWS CLI over a region: `const aws = awsCli(region); await aws('s3api list-buckets')`.
// Output is returned rather than printed, since a page renders it and a test asserts on it
export function awsCli(region: Dispatcher, options: AwsCliOptions = {}) {
  const clients = clientsFor(region);
  return async function aws(command: string | string[]): Promise<CliResult> {
    const argv = typeof command === 'string' ? tokenize(command) : command;
    let result: CliResult;
    try {
      const askedForHelp = argv.length === 0 || argv[0] === 'help' || argv.includes('--help');
      const stdout = askedForHelp
        ? USAGE
        : argv[0] === 's3'
          ? await runS3Verb(argv.slice(1), clients, options.files)
          : await dispatch(parseArgs(argv), clients);
      result = { stdout, stderr: '', code: 0 };
    } catch (error) {
      result = { stdout: '', ...report(error) };
    }
    if (result.code !== 0 && options.throwOnError) throw new CliError(result);
    return result;
  };
}
