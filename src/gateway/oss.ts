import { createHmac, randomBytes } from 'node:crypto';
import { request } from 'node:https';

export interface OssConfig {
  enabled: boolean;
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  endpoint: string;
  prefix: string;
}

export interface OssUploadResult {
  url: string;
  objectKey: string;
}

function normalizeEndpoint(value: string): URL {
  const raw = value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!raw) throw new Error('OSS endpoint is required');
  const endpoint = new URL(`https://${raw}`);
  if (endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('OSS endpoint must be a hostname');
  return endpoint;
}

function safePrefix(value: string): string {
  return value.split('/')
    .map((part) => part.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join('/');
}

function safeExtension(filename: string): string {
  const match = filename.toLowerCase().match(/\.([a-z0-9]{1,12})$/);
  return match?.[1] ?? 'bin';
}

function encodedObjectKey(objectKey: string): string {
  return objectKey.split('/').map(encodeURIComponent).join('/');
}

export function createOssObjectKey(filename: string, prefix: string, timestamp = Date.now(), randomHex = randomBytes(4).toString('hex')): string {
  const leaf = `${timestamp}_${randomHex}.${safeExtension(filename)}`;
  const normalizedPrefix = safePrefix(prefix);
  return normalizedPrefix ? `${normalizedPrefix}/${leaf}` : leaf;
}

export function createOssAuthorization(config: Pick<OssConfig, 'accessKeyId' | 'accessKeySecret' | 'bucket'>, method: string, contentType: string, date: string, objectKey: string): string {
  const stringToSign = `${method}\n\n${contentType}\n${date}\n/${config.bucket}/${objectKey}`;
  const signature = createHmac('sha1', config.accessKeySecret).update(stringToSign).digest('base64');
  return `OSS ${config.accessKeyId}:${signature}`;
}

export async function uploadToOss(data: Buffer, filename: string, contentType: string, config: OssConfig): Promise<OssUploadResult> {
  if (!config.accessKeyId || !config.accessKeySecret || !config.bucket) {
    throw new Error('OSS is enabled but accessKeyId, accessKeySecret, or bucket is missing');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(config.bucket)) throw new Error('OSS bucket is invalid');

  const endpoint = normalizeEndpoint(config.endpoint);
  const objectKey = createOssObjectKey(filename, config.prefix);
  const objectPath = encodedObjectKey(objectKey);
  const date = new Date().toUTCString();
  const hostname = `${config.bucket}.${endpoint.hostname}`;
  const authorization = createOssAuthorization(config, 'PUT', contentType, date, objectKey);

  await new Promise<void>((resolve, reject) => {
    const upload = request({
      protocol: 'https:',
      hostname,
      port: endpoint.port || undefined,
      path: `/${objectPath}`,
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': data.byteLength,
        Date: date,
        Authorization: authorization,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let responseBytes = 0;
      response.on('data', (chunk: Buffer) => {
        if (responseBytes >= 16_384) return;
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += value.byteLength;
        chunks.push(value.subarray(0, Math.max(0, 16_384 - (responseBytes - value.byteLength))));
      });
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve();
        else reject(new Error(`OSS upload failed (${status}): ${Buffer.concat(chunks).toString('utf8').trim() || response.statusMessage || 'unknown error'}`));
      });
    });
    upload.on('error', reject);
    upload.setTimeout(60_000, () => upload.destroy(new Error('OSS upload timed out after 60 seconds')));
    upload.end(data);
  });

  return { url: `https://${hostname}/${objectPath}`, objectKey };
}
