export const handler = async ({ password }) => {
  const started = Date.now();
  let hash = 2166136261;
  for (let i = 0; i < 600_000_000; i++) {
    hash = Math.imul(hash ^ password.charCodeAt(i % password.length), 16777619);
  }
  return {
    environment: process.env.AWS_LAMBDA_LOG_STREAM_NAME,
    hash: (hash >>> 0).toString(16).padStart(8, "0"),
    started,
    finished: Date.now(),
  };
};
