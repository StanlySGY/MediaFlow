import { describe, expect, it } from 'vitest';
import { crc32, textEntry, zipEntries } from './zip';

/** Read a little-endian u32/u16 out of the archive so the assertions are about
 *  the bytes a real unzip would read, not about our own writer's API. */
const view = async (blob: Blob) => new DataView(await blob.arrayBuffer());

describe('zipEntries', () => {
  it('writes a readable stored archive with a central directory', async () => {
    const blob = zipEntries([
      textEntry('会议.txt', '你好'),
      { name: 'audio.webm', data: new Uint8Array([1, 2, 3]) },
    ], new Date(2026, 9, 20, 15, 30, 0));
    const dv = await view(blob);
    const bytes = new Uint8Array(dv.buffer);

    expect(blob.type).toBe('application/zip');
    // Local header of the first entry.
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint16(8, true)).toBe(0); // stored, not deflated
    expect(dv.getUint16(6, true)).toBe(0x0800); // UTF-8 filename flag
    expect(dv.getUint32(18, true)).toBe(6); // '你好' is 3 bytes each

    // End-of-central-directory record closes the archive.
    const endOffset = dv.byteLength - 22;
    expect(dv.getUint32(endOffset, true)).toBe(0x06054b50);
    expect(dv.getUint16(endOffset + 10, true)).toBe(2); // two entries
    const centralOffset = dv.getUint32(endOffset + 16, true);
    expect(dv.getUint32(centralOffset, true)).toBe(0x02014b50);
    // The name is stored verbatim in UTF-8.
    const nameLength = dv.getUint16(centralOffset + 28, true);
    const nameBytes = bytes.slice(centralOffset + 46, centralOffset + 46 + nameLength);
    expect(new TextDecoder().decode(nameBytes)).toBe('会议.txt');
  });

  it('computes the CRC the format specifies', () => {
    // 0xCBF43926 is the canonical CRC-32 of "123456789".
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('produces an empty but valid archive for no entries', async () => {
    const dv = await view(zipEntries([]));
    expect(dv.byteLength).toBe(22);
    expect(dv.getUint32(0, true)).toBe(0x06054b50);
    expect(dv.getUint16(10, true)).toBe(0);
  });
});
