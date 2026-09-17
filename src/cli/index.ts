import type { Dispatcher } from '../core.ts';
import { parseArgs, tokenize } from './args.ts';
import { dispatch, serviceNames, servicesFor, type Modules } from './dispatch.ts';
import { report, usageText } from './errors.ts';
import type { Files } from './files.ts';
import { runS3Verb } from './s3-verbs.ts';

export type { Modules, SdkModule } from './dispatch.ts';
export type { Files } from './files.ts';

export type CliResult = { stdout: string; stderr: string; code: number };
export type AwsCli = (command: string | string[]) => Promise<CliResult>;

export type AwsCliOptions = {
  // A non-zero exit becomes a rejection, which is what a test wants and a terminal does not
  throwOnError?: boolean;
  // Where `s3 cp` and a blob flag's `fileb://` path read and write; Node finds its own, a page has none
  files?: Files;
  // SDK client packages, keyed by resolved SDK name - `s3`, not `s3api`. Without them a
  // service is imported on demand, which no bundler can follow, so a bundle needs these
  modules?: Modules;
  // Merged into every client's config, so a caller can move the endpoint and the credentials.
  // The addressing a service needs wins over it: S3 stays path-style whatever this says
  client?: object;
  // Appended to the usage text, for advice only the host can give: where credentials come
  // from, what this shell can reach
  note?: string;
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
export function awsCli(region: Dispatcher, options: AwsCliOptions = {}): AwsCli {
  const services = servicesFor(region, options);
  const usage = usageText(options.modules && serviceNames(options.modules), options.note);
  return async function aws(command) {
    const argv = typeof command === 'string' ? tokenize(command) : command;
    let result: CliResult;
    try {
      const askedForHelp = argv.length === 0 || argv[0] === 'help' || argv.includes('--help');
      const stdout = askedForHelp
        ? usage
        : argv[0] === 's3'
          ? await runS3Verb(argv.slice(1), services, options.files)
          : await dispatch(parseArgs(argv), services, options.files);
      result = { stdout, stderr: '', code: 0 };
    } catch (error) {
      result = { stdout: '', ...report(error, usage) };
    }
    if (result.code !== 0 && options.throwOnError) throw new CliError(result);
    return result;
  };
}
