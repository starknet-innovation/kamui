import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { isNetworkVolume } from './volume';

test('the default probe reports a local temp directory as a local disk', () => {
  expect(isNetworkVolume(tmpdir())).toBe(false);
});
