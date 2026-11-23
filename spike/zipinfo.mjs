// Reads a zip's table of contents using only ranged reads, the way the
// worker will read staged zips in S3. Returns aggregate facts only: no file
// names leave this module except the top-level product folders.

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/**
 * @param {(start: number, endInclusive: number) => Promise<Buffer>} readRange
 * @param {number} totalSize
 */
export async function readZipInfo(readRange, totalSize) {
  const tailLen = Math.min(totalSize, 66000);
  const tailStart = totalSize - tailLen;
  const tail = await readRange(tailStart, totalSize - 1);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("end-of-central-directory record not found");

  let entries = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  let zip64Eocd = false;

  const locator = eocd - 20;
  if (locator >= 0 && tail.readUInt32LE(locator) === ZIP64_LOCATOR_SIG) {
    const z64Offset = Number(tail.readBigUInt64LE(locator + 8));
    const rec = z64Offset >= tailStart
      ? tail.subarray(z64Offset - tailStart, z64Offset - tailStart + 56)
      : await readRange(z64Offset, z64Offset + 55);
    if (rec.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new Error("bad ZIP64 end-of-central-directory record");
    zip64Eocd = true;
    entries = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }

  const cd = await readRange(cdOffset, cdOffset + cdSize - 1);

  const stats = {
    zip64EndRecord: zip64Eocd,
    entries,
    files: 0,
    directories: 0,
    methods: {},
    utf8Names: 0,
    dataDescriptorFlag: 0,
    zip64ExtraFields: 0,
    filesWithZeroCrc: 0,
    totalUncompressedBytes: 0,
    totalCompressedBytes: 0,
    largestFileBytes: 0,
    longestNameBytes: 0,
    productFolders: new Set(),
    firstLocalHeaderReadable: null,
  };

  let p = 0;
  let firstFileOffset = null;
  for (let n = 0; n < entries; n++) {
    if (cd.readUInt32LE(p) !== CDH_SIG) throw new Error(`bad central directory entry at #${n}`);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let comp = cd.readUInt32LE(p + 20);
    let uncomp = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);

    // ZIP64 extended information extra field (0x0001).
    for (let e = 0; e + 4 <= extra.length;) {
      const id = extra.readUInt16LE(e);
      const size = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        stats.zip64ExtraFields++;
        let q = e + 4;
        if (uncomp === 0xffffffff) { uncomp = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (comp === 0xffffffff) { comp = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(extra.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + size;
    }

    const isDir = name.endsWith("/");
    if (isDir) stats.directories++;
    else {
      stats.files++;
      if (crc === 0 && uncomp > 0) stats.filesWithZeroCrc++;
      stats.totalUncompressedBytes += uncomp;
      stats.totalCompressedBytes += comp;
      stats.largestFileBytes = Math.max(stats.largestFileBytes, uncomp);
      if (firstFileOffset === null) firstFileOffset = localOffset;
    }
    stats.methods[method] = (stats.methods[method] || 0) + 1;
    if (flags & 0x800) stats.utf8Names++;
    if (flags & 0x8) stats.dataDescriptorFlag++;
    stats.longestNameBytes = Math.max(stats.longestNameBytes, nameLen);
    const parts = name.split("/");
    if (parts.length > 2 && parts[0] === "Takeout") stats.productFolders.add(parts[1]);

    p += 46 + nameLen + extraLen + commentLen;
  }

  if (firstFileOffset !== null) {
    const lfh = await readRange(firstFileOffset, firstFileOffset + 29);
    stats.firstLocalHeaderReadable = lfh.readUInt32LE(0) === LFH_SIG;
  }

  return { ...stats, productFolders: [...stats.productFolders].sort() };
}
