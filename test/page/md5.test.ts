import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { md5hex } from '../../src/page/md5.ts';

describe('md5hex', () => {
  it('agrees with node:crypto across the padding boundaries, as lowercase hex', () => {
    for (const n of [0, 1, 3, 4, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 65_537]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
      expect(md5hex(bytes), `${n} bytes`).toBe(createHash('md5').update(bytes).digest('hex'));
    }
  });
});
