import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { attachmentContext } from '../src/gateway/server.js';
import { createOssAuthorization, createOssObjectKey } from '../src/gateway/oss.js';

test('OSS V1 authorization uses the required canonical string', () => {
  const authorization = createOssAuthorization(
    { accessKeyId: 'test-id', accessKeySecret: 'secret', bucket: 'renlg' },
    'PUT',
    'image/png',
    'Wed, 18 Aug 2026 12:00:00 GMT',
    'chat/123_deadbeef.png',
  );
  assert.equal(authorization, 'OSS test-id:DpBhbigEtFpvqh4QJWTa42NTQBI=');
});

test('OSS object keys contain a safe prefix, timestamp, random hex, and extension', () => {
  assert.equal(createOssObjectKey('截图 1.JPG', '聊天 上传/images', 123, 'deadbeef'), 'images/123_deadbeef.jpg');
  assert.equal(createOssObjectKey('archive', '', 456, '0123abcd'), '456_0123abcd.bin');
});

test('remote image attachments become markdown images without local stat checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-remote-attachment-test-'));
  try {
    const context = await attachmentContext([{
      name: 'screen.png', path: 'https://renlg.oss-cn-hangzhou.aliyuncs.com/taiwei/123_deadbeef.png',
      size: 123, type: 'image/png',
    }], directory);
    assert.match(context, /\[图片\] screen\.png: https:\/\/renlg\.oss-cn-hangzhou\.aliyuncs\.com\/taiwei\/123_deadbeef\.png/);
    assert.match(context, /generate_image/);

    const documentContext = await attachmentContext([{
      name: 'manual.pdf', path: 'https://renlg.oss-cn-hangzhou.aliyuncs.com/taiwei/123_deadbeef.pdf',
      size: 456, type: 'application/pdf',
    }], directory);
    assert.match(documentContext, /\[附件\] manual\.pdf: https:\/\//);

    const textContext = await attachmentContext([{
      name: 'notes.txt', path: 'https://renlg.oss-cn-hangzhou.aliyuncs.com/taiwei/123_deadbeef.txt',
      size: 12, type: 'text/plain', content: 'remote text', contentTruncated: true,
    }], directory);
    assert.match(textContext, /\[附件: notes\.txt\]\nremote text\n\[内容已截断\]/);

    await assert.rejects(() => attachmentContext([{
      name: 'forged.txt', path: 'https://example.com/forged.txt', type: 'text/plain', content: 'x'.repeat(8_001),
    }], directory), /at most 8000 characters/);
    await assert.rejects(() => attachmentContext([{
      name: 'archive.zip', path: 'https://example.com/archive.zip', type: 'application/zip', content: 'forged',
    }], directory), /only allowed for text files/);
    await assert.rejects(() => attachmentContext(Array.from({ length: 6 }, (_, index) => ({
      name: `file-${index}.txt`, path: `https://example.com/file-${index}.txt`, type: 'text/plain', content: 'ok',
    })), directory), /at most 5 uploads/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
