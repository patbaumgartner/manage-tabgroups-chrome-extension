/**
 * A tiny, deterministic ZIP writer.
 *
 * Written by hand so the release artifact needs no third-party dependency, and
 * so every field that would otherwise vary between machines (timestamps, entry
 * order, external attributes) is pinned. The same input therefore always
 * produces a byte-identical archive, which makes the published checksum
 * reproducible.
 */

import { deflateRawSync } from 'node:zlib';

/** MS-DOS timestamp for 1980-01-01 00:00:00, the earliest value the format allows. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * @param {Uint8Array} data
 * @returns {number} CRC-32 of `data`.
 */
export function crc32(data) {
  let crc = 0xff_ff_ff_ff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/**
 * @typedef {object} ZipEntry
 * @property {string} name Archive path, using forward slashes.
 * @property {Uint8Array} data
 */

/**
 * Build a ZIP archive.
 *
 * @param {readonly ZipEntry[]} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  /** @type {Buffer[]} */
  const localParts = [];
  /** @type {Buffer[]} */
  const centralParts = [];
  let offset = 0;

  for (const entry of sorted) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const uncompressed = Buffer.from(entry.data);
    const compressed = deflateRawSync(uncompressed, { level: 9 });
    const checksum = crc32(uncompressed);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04_03_4b_50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(8, 10); // deflate
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    centralHeader.writeUInt32LE(0, 38); // external attributes
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + compressed.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, central, end]);
}
