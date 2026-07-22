import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { ObjectStorage } from '../domain.js';
import type { AppConfig } from '../config.js';

export class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, Buffer>();
  async put(key: string, data: Buffer) { this.objects.set(key, Buffer.from(data)); }
  async get(key: string) { const data = this.objects.get(key); if (!data) throw new Error('Attachment not found'); return Buffer.from(data); }
  async delete(key: string) { this.objects.delete(key); }
}

export class FileObjectStorage implements ObjectStorage {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private pathFor(key: string) {
    const target = resolve(this.root, key);
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) throw new Error('Invalid attachment key');
    return target;
  }
  async put(key: string, data: Buffer) {
    const target = this.pathFor(key);
    const temporaryPath = `${target}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temporaryPath, data);
    await rename(temporaryPath, target);
  }
  async get(key: string) { return readFile(this.pathFor(key)); }
  async delete(key: string) { await rm(this.pathFor(key), { force: true }); }
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  constructor(private readonly config: AppConfig['s3']) {
    this.client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle, credentials: config.accessKeyId && config.secretAccessKey ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } : undefined });
  }
  async put(key: string, data: Buffer, contentType: string) { await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: data, ContentType: contentType, ServerSideEncryption: 'AES256' })); }
  async get(key: string) { const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key })); if (!response.Body) throw new Error('Attachment not found'); return Buffer.from(await response.Body.transformToByteArray()); }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key })); }
}
