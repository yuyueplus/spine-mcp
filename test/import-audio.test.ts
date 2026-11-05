import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { nativeImportAudioRoot } from '../src/import-audio.js';
import { parseDocument } from '../src/document.js';

test('native import audio is relative to the native project, including implicit referenced roots', () => {
  const source = path.resolve('fixtures/角色 with spaces'), output = path.resolve('delivery/runtime'), data = parseDocument({ skeleton: { spine: '4.3.23', audio: './音效' }, bones: [{ name: 'root' }], events: { step: { audio: 'step.wav' } } });
  assert.equal(path.resolve(output, nativeImportAudioRoot(data, source, output)!), path.resolve(source, '音效'));
  delete data.skeleton.audio; assert.equal(path.resolve(output, nativeImportAudioRoot(data, source, output)!), source);
});
test('unused absent audio roots are not invented while an explicit root remains preservable', () => {
  const data = parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }] }), base = path.resolve('fixture');
  assert.equal(nativeImportAudioRoot(data, base, base), undefined); data.skeleton.audio = '.'; assert.equal(nativeImportAudioRoot(data, base, base), '.');
});
