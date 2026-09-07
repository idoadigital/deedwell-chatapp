/** Minimal ZIP writer (STORE method, no compression) so "download all
 *  deliverables" needs no dependency. Files are already-compressed media
 *  or small text, so deflate would buy little. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

export interface ZipEntry { name: string; data: Buffer; modified?: Date }

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    let name = entry.name.replace(/\\/g, "/").replace(/^\/+/, "");
    // Duplicate names are legal in a zip but confusing on extract.
    if (seen.has(name)) { const dot = name.lastIndexOf("."); name = dot > 0 ? `${name.slice(0, dot)}-${seen.size}${name.slice(dot)}` : `${name}-${seen.size}`; }
    seen.add(name);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(entry.data);
    const { time, date } = dosDateTime(entry.modified ?? new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.data.length, 18); local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(entry.data.length, 20); central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + entry.data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}
