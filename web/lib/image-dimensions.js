'use strict';

// Metadata only: never inflate raster data or allocate a width*height buffer.
// PNG: https://www.w3.org/TR/png-3/#11IHDR
// GIF: https://www.w3.org/Graphics/GIF/spec-gif89a.txt
// JPEG markers: https://github.com/libjpeg-turbo/libjpeg-turbo/blob/main/src/jdmarker.c
// WebP: https://developers.google.com/speed/webp/docs/riff_container
const MAX_IMAGE_SIDE = 8192;
const MAX_IMAGE_PIXELS = 16_000_000;
const invalid = () => { throw new Error('assignment-image-invalid'); };
const animated = () => { throw new Error('assignment-image-animation-not-supported'); };
function bounded(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) invalid();
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS)
    throw new Error('assignment-image-dimensions-too-large');
  return { width, height };
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(buffer) {
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') invalid();
  const dimensions = bounded(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[buffer[25]]?.includes(buffer[24]) || buffer[26] || buffer[27] || buffer[28] > 1
      || crc32(buffer.subarray(12, 29)) !== buffer.readUInt32BE(29)) invalid();
  let imageData = false;
  for (let offset = 8; offset < buffer.length;) {
    if (offset + 12 > buffer.length) invalid();
    const size = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + size;
    if (end > buffer.length || (type === 'IHDR' && offset !== 8)) invalid();
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) animated();
    if (type === 'IDAT' && size) imageData = true;
    if (type === 'IEND') { if (size || !imageData || end !== buffer.length) invalid(); return dimensions; }
    offset = end;
  }
  invalid();
}
function gif(buffer) {
  if (buffer.length < 14 || !['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) invalid();
  const dimensions = bounded(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
  let offset = 13 + ((buffer[10] & 128) ? 3 * (2 ** ((buffer[10] & 7) + 1)) : 0), frames = 0;
  const blocks = () => {
    let bytes = 0;
    for (;;) {
      if (offset >= buffer.length) invalid();
      const size = buffer[offset++];
      if (!size) return bytes;
      offset += size; bytes += size;
      if (offset > buffer.length) invalid();
    }
  };
  while (offset < buffer.length) {
    const marker = buffer[offset++];
    if (marker === 0x3b) { if (frames !== 1 || offset !== buffer.length) invalid(); return dimensions; }
    if (marker === 0x21) { if (offset >= buffer.length) invalid(); offset++; blocks(); continue; }
    if (marker !== 0x2c || offset + 9 > buffer.length) invalid();
    if (++frames > 1) animated();
    const frame = bounded(buffer.readUInt16LE(offset + 4), buffer.readUInt16LE(offset + 6));
    if (buffer.readUInt16LE(offset) + frame.width > dimensions.width
        || buffer.readUInt16LE(offset + 2) + frame.height > dimensions.height) invalid();
    const packed = buffer[offset + 8];
    offset += 9 + ((packed & 128) ? 3 * (2 ** ((packed & 7) + 1)) : 0);
    if (offset >= buffer.length || buffer[offset] < 2 || buffer[offset++] > 8 || !blocks()) invalid();
  }
  invalid();
}
function jpeg(buffer) {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) invalid();
  let offset = 2, dimensions, components, scan = false, sawScan = false;
  while (offset < buffer.length) {
    if (scan) { offset = buffer.indexOf(255, offset); if (offset < 0) invalid(); }
    if (buffer[offset++] !== 255) invalid();
    while (buffer[offset] === 255) offset++;
    if (offset >= buffer.length) invalid();
    const marker = buffer[offset++];
    if (scan && (marker === 0 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    scan = false;
    if (marker === 0xd9) { if (!dimensions || !sawScan || offset !== buffer.length) invalid(); return dimensions; }
    if (marker === 0x01) continue;
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)
        || marker === 0xdc || marker === 0xde || offset + 2 > buffer.length) invalid();
    const size = buffer.readUInt16BE(offset);
    if (size < 2 || offset + size > buffer.length) invalid();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (dimensions || size < 8) invalid();
      components = buffer[offset + 7];
      if (components < 1 || components > 4 || size !== 8 + components * 3
          || buffer[offset + 2] < 2 || buffer[offset + 2] > 16) invalid();
      dimensions = bounded(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
    }
    if (marker === 0xda) {
      const count = buffer[offset + 2];
      if (!dimensions || count < 1 || count > components || size !== 6 + count * 2) invalid();
      scan = true; sawScan = true;
    }
    offset += size;
  }
  invalid();
}
function webp(buffer) {
  if (buffer.length < 20 || buffer.toString('ascii', 0, 4) !== 'RIFF'
      || buffer.toString('ascii', 8, 12) !== 'WEBP' || buffer.readUInt32LE(4) + 8 !== buffer.length) invalid();
  let canvas, image;
  for (let offset = 12; offset < buffer.length;) {
    if (offset + 8 > buffer.length) invalid();
    const type = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + size, next = end + (size & 1);
    if (next > buffer.length || ((size & 1) && buffer[end] !== 0)
        || (offset === 12 && !['VP8 ', 'VP8L', 'VP8X'].includes(type))) invalid();
    if (type === 'ANIM' || type === 'ANMF') animated();
    if (type === 'VP8X') {
      if (offset !== 12 || size !== 10 || (buffer[start] & 0xc1) || buffer.readUIntLE(start + 1, 3)) invalid();
      if (buffer[start] & 2) animated();
      canvas = bounded(buffer.readUIntLE(start + 4, 3) + 1, buffer.readUIntLE(start + 7, 3) + 1);
    }
    if (type === 'VP8 ' || type === 'VP8L') {
      if (image) invalid();
      if (type === 'VP8 ') {
        if (size <= 10 || (buffer[start] & 1) || buffer.toString('hex', start + 3, start + 6) !== '9d012a') invalid();
        image = bounded(buffer.readUInt16LE(start + 6) & 0x3fff, buffer.readUInt16LE(start + 8) & 0x3fff);
      } else {
        if (size <= 5 || buffer[start] !== 0x2f) invalid();
        const packed = buffer.readUInt32LE(start + 1);
        if (packed >>> 29) invalid();
        image = bounded((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
      }
    }
    offset = next;
  }
  if (!image || (canvas && (canvas.width !== image.width || canvas.height !== image.height))) invalid();
  return canvas || image;
}
const parsers = new Map([['image/png', png], ['image/jpeg', jpeg], ['image/gif', gif], ['image/webp', webp]]);
function validateImageDimensions(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) invalid();
  const parser = parsers.get(mimeType);
  if (!parser) invalid();
  return parser(buffer);
}

module.exports = { validateImageDimensions, MAX_IMAGE_SIDE, MAX_IMAGE_PIXELS };
