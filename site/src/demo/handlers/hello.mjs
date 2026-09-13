export const handler = async (event, context) => {
  return {
    message: `hello, ${event.name}`,
    functionName: context.functionName,
    requestId: context.awsRequestId,
  };
};
