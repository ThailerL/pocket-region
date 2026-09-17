import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

export const handler = async ({ id, item, quantity }) => {
  await s3.send(new PutObjectCommand({ Bucket: "orders", Key: `${id}.json`, Body: JSON.stringify({ item, quantity }) }));
  const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: "orders" }));
  return Contents.map((object) => object.Key);
};
