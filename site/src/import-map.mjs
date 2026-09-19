// The demo and the runnable docs examples import as shown, and resolve here: the region, Pyodide,
// and the SDK clients are served as they are, never bundled
export const importMap = {
  imports: {
    'pocket-region/browser': '/region/dist/browser.js',
    'pocket-region/vendor/': '/region/vendor/',
    '@aws-sdk/client-s3': 'https://cdn.jsdelivr.net/npm/@aws-sdk/client-s3@3.1131.0/+esm',
    '@aws-sdk/client-sqs': 'https://cdn.jsdelivr.net/npm/@aws-sdk/client-sqs@3.1131.0/+esm',
    '@aws-sdk/client-sns': 'https://cdn.jsdelivr.net/npm/@aws-sdk/client-sns@3.1131.0/+esm',
    '@aws-sdk/client-dynamodb': 'https://cdn.jsdelivr.net/npm/@aws-sdk/client-dynamodb@3.1131.0/+esm',
    '@aws-sdk/client-lambda': 'https://cdn.jsdelivr.net/npm/@aws-sdk/client-lambda@3.1131.0/+esm',
    '@aws-sdk/client-eventbridge': 'https://cdn.jsdelivr.net/npm/@aws-sdk/client-eventbridge@3.1131.0/+esm',
    '@aws-sdk/client-secrets-manager': 'https://cdn.jsdelivr.net/npm/@aws-sdk/client-secrets-manager@3.1131.0/+esm',
    '@aws-sdk/client-ssm': 'https://cdn.jsdelivr.net/npm/@aws-sdk/client-ssm@3.1131.0/+esm',
    '@aws-sdk/client-kms': 'https://cdn.jsdelivr.net/npm/@aws-sdk/client-kms@3.1131.0/+esm',
    '@aws-sdk/client-cloudwatch-logs': 'https://cdn.jsdelivr.net/npm/@aws-sdk/client-cloudwatch-logs@3.1131.0/+esm',
    '@aws-sdk/client-kinesis': 'https://cdn.jsdelivr.net/npm/@aws-sdk/client-kinesis@3.1131.0/+esm',
    '@aws-sdk/client-sfn': 'https://cdn.jsdelivr.net/npm/@aws-sdk/client-sfn@3.1131.0/+esm',
    fflate: 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js',
    // The runner loads it for snippets: the SDK parses XML with the DOM, which a worker lacks
    '@xmldom/xmldom': 'https://cdn.jsdelivr.net/npm/@xmldom/xmldom@0.9.12/+esm',
  },
};
