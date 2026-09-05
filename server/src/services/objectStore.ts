import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";

const s3 = config.STORAGE_DRIVER === "s3" ? new S3Client({ region: config.AWS_REGION }) : null;

export function localObjectPath(objectKey: string): string {
  const root = path.resolve(config.STORAGE_ROOT);
  const target = path.resolve(root, objectKey);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error("Stored object path escapes storage root");
  return target;
}

function s3Key(objectKey: string): string {
  return config.S3_KEY_PREFIX ? `${config.S3_KEY_PREFIX.replace(/\/+$/, "")}/${objectKey}` : objectKey;
}

function requireS3(): { client: S3Client; bucket: string } {
  if (!s3 || !config.S3_BUCKET) throw new Error("S3 object storage is not configured");
  return { client: s3, bucket: config.S3_BUCKET };
}

export async function putObjectNew(objectKey: string, bytes: Buffer, contentType?: string): Promise<void> {
  if (config.STORAGE_DRIVER === "local") {
    const target = localObjectPath(objectKey);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
    await writeFile(target, bytes, { flag: "wx", mode: 0o640 });
    return;
  }
  const { client, bucket } = requireS3();
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: s3Key(objectKey), Body: bytes, ContentType: contentType, IfNoneMatch: "*", ServerSideEncryption: "AES256" }));
}

export async function readObjectBytes(objectKey: string): Promise<Buffer> {
  if (config.STORAGE_DRIVER === "local") return readFile(localObjectPath(objectKey));
  const { client, bucket } = requireS3();
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key(objectKey) }));
  if (!response.Body) throw new Error("Stored object has no body");
  return Buffer.from(await response.Body.transformToByteArray());
}

export async function deleteObjectBytes(objectKey: string): Promise<void> {
  if (config.STORAGE_DRIVER === "local") {
    await unlink(localObjectPath(objectKey));
    return;
  }
  const { client, bucket } = requireS3();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3Key(objectKey) }));
}

export async function probeObjectStore(): Promise<void> {
  const key = `.cirkle-readiness/${randomUUID()}`;
  const expected = Buffer.from(randomUUID());
  let created = false;
  try {
    await putObjectNew(key, expected, "text/plain");
    created = true;
    const actual = await readObjectBytes(key);
    if (!actual.equals(expected)) throw new Error("Storage readiness probe returned unexpected content");
  } finally {
    if (created) await deleteObjectBytes(key);
  }
}
