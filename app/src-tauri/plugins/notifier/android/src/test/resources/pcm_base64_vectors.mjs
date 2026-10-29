// Generator for pcm_base64_vectors.jsonl. Run: node pcm_base64_vectors.mjs > pcm_base64_vectors.jsonl
// The decision mirrors app/src/lib/call/pure.ts base64ToPcm (length cap, atob, non-empty, even byte count).
function base64ToPcmBytes(b64) {
  if (typeof b64 !== 'string' || b64.length > 8192) return null;
  try {
    const bin = atob(b64);
    if (bin.length === 0 || bin.length % 2 !== 0) return null;
    return bin.length;
  } catch {
    return null;
  }
}
const pad = (bytes) => {
  const b = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) b[i] = (i * 37) & 0xff;
  return Buffer.from(b).toString('base64');
};
const frame = pad(1600); // 2136 padded chars
const cases = [
  frame,
  frame.replace(/=+$/, ''), // unpadded 2134 chars
  frame.replace(/(.{76})/g, '$1\n'), // ASCII newlines inside
  ' ' + frame + '\t',
  'AAA', // unpadded 2 bytes
  'AAA=', // padded 2 bytes
  'AAAAAA==', // 4 bytes
  'AA', // 1 byte (odd)
  'AAAA', // 3 bytes (odd)
  'AA==', // 1 byte (odd)
  'AAAAA', // length mod 4 == 1
  'AB=', // '=' with len mod 4 == 3
  'A===', // too much padding
  'AAAA====', // padding in the wrong place
  'AAAA==A=', // padding in the middle
  '-_-_', // URL-safe alphabet
  '@@@@', // invalid characters
  'AA\u00a0AA=', // non-breaking space is not ASCII whitespace
  'AAé=', // non-ASCII
  '',
  'A'.repeat(8192), // 6144 bytes at the cap
  'A'.repeat(8196), // over the cap
];
for (const c of cases) {
  process.stdout.write(JSON.stringify({ in: c, bytes: base64ToPcmBytes(c) }) + '\n');
}
