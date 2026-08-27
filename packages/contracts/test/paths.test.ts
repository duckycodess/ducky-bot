import { describe, expect, it } from 'vitest';
import { assertRepoRelativePath, isRepoRelativePath } from '../src/paths.js';

describe('repository-relative path guard', () => {
  it('accepts ordinary relative paths', () => {
    for (const p of ['a.ts', 'src/a.ts', 'src/nested/deep/file.test.ts', 'a-b_c.1.txt']) {
      expect(isRepoRelativePath(p), p).toBe(true);
    }
  });

  it('rejects absolute, traversal, UNC, drive, home and NUL paths', () => {
    const bad = [
      '/etc/passwd',
      '../secrets',
      'src/../../etc/passwd',
      './src/a.ts',
      '~/notes.txt',
      'C:\\Windows\\system32',
      '//server/share',
      'src\\windows.ts',
      'src/a.ts\u0000.png',
      '',
      'src//double.ts',
      'src/',
    ];
    for (const p of bad) {
      expect(isRepoRelativePath(p), p).toBe(false);
      expect(() => assertRepoRelativePath(p)).toThrow();
    }
  });

  it('rejects non-strings', () => {
    for (const p of [null, undefined, 42, {}, []]) expect(isRepoRelativePath(p)).toBe(false);
  });
});
