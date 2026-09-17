import type { LambdaApi } from './modules.ts';
import { zipOf } from './zip.ts';

// Creates the function, or replaces its code when it already exists
export async function deployFunction({ sdk, client }: LambdaApi, FunctionName: string, source: string, Timeout?: number) {
  const ZipFile = await zipOf('index.mjs', source);
  try {
    await client.send(
      new sdk.CreateFunctionCommand({
        FunctionName,
        Runtime: 'nodejs22.x',
        Handler: 'index.handler',
        Role: 'arn:aws:iam::000000000000:role/lambda',
        Timeout,
        Code: { ZipFile },
      }),
    );
  } catch (error) {
    if (!(error instanceof sdk.ResourceConflictException)) throw error;
    await client.send(new sdk.UpdateFunctionCodeCommand({ FunctionName, ZipFile }));
  }
}
