import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { replaceFile } from '../src/file-replace.js';
import { atomicJson } from '../src/jobs.js';

test('locked Windows replacements retain the previous file until the rename succeeds', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spine-file-replace-'));
  const source = path.join(directory, 'new.png'), target = path.join(directory, 'preview.png');
  await writeFile(source, 'new complete image'); await writeFile(target, 'last good image'); let calls = 0;
  await replaceFile(source, target, async (from, to) => {
    calls++;
    if (calls <= 2) { assert.equal(await readFile(target, 'utf8'), 'last good image'); throw Object.assign(new Error('temporary image watcher lock'), { code: calls === 1 ? 'EPERM' : 'EBUSY' }); }
    return rename(from, to);
  });
  assert.equal(await readFile(target, 'utf8'), 'new complete image'); assert.equal(calls, 3);
});

test('permanent atomic JSON publication errors leave no temporary file and retain the destination', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spine-json-replace-')), target = path.join(directory, 'keep-directory');
  const { mkdir } = await import('node:fs/promises'); await mkdir(target); await writeFile(path.join(target, 'sentinel.txt'), 'retained');
  await assert.rejects(atomicJson(target, { changed: true }));
  assert.equal(await readFile(path.join(target, 'sentinel.txt'), 'utf8'), 'retained'); assert.deepEqual(await readdir(directory), ['keep-directory']);
});
