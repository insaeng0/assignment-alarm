const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const zlib = require('node:zlib');
const { validateImageDimensions: validate, MAX_IMAGE_SIDE, MAX_IMAGE_PIXELS } = require('../lib/image-dimensions');
const invalid = /assignment-image-invalid/;
const tooLarge = /assignment-image-dimensions-too-large/;
const animated = /assignment-image-animation-not-supported/;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const label = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([label, data])));
  return Buffer.concat([size, label, data, crc]);
}
function png(width, height, chunks = [], compressed = zlib.deflateSync(Buffer.from([0, 0, 0, 0, 255]))) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), ...chunks, pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}
function segment(marker, data) {
  const header = Buffer.from([255, marker, 0, 0]); header.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([header, data]);
}
// Synthetic container fixtures below exercise metadata and marker boundaries;
// pixel decoding is deliberately outside this module's responsibility.
function jpeg(width, height, extra = []) {
  const sof = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]); sof.writeUInt16BE(height, 1); sof.writeUInt16BE(width, 3);
  return Buffer.concat([Buffer.from([255, 216]), ...extra, segment(0xc0, sof), segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([17, 255, 0, 34, 255, 208, 51, 255, 217])]);
}
function gifFrame(width, height, left = 0) {
  const descriptor = Buffer.alloc(10); descriptor[0] = 0x2c; descriptor.writeUInt16LE(left, 1); descriptor.writeUInt16LE(width, 5); descriptor.writeUInt16LE(height, 7);
  return Buffer.concat([descriptor, Buffer.from([2, 2, 0x44, 1, 0])]);
}
function gif(width, height, frames = [gifFrame(width, height)], extension = Buffer.alloc(0)) {
  const header = Buffer.alloc(13); header.write('GIF89a'); header.writeUInt16LE(width, 6); header.writeUInt16LE(height, 8); header[10] = 0x80;
  return Buffer.concat([header, Buffer.from([0, 0, 0, 255, 255, 255]), extension, ...frames, Buffer.from([0x3b])]);
}
function webpChunk(type, data) {
  const header = Buffer.alloc(8); header.write(type); header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length & 1)]);
}
function riff(chunks) {
  const data = Buffer.concat(chunks), header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(data.length + 4, 4); header.write('WEBP', 8);
  return Buffer.concat([header, data]);
}
function vp8(width, height) {
  const data = Buffer.from([16, 0, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0, 0]); data.writeUInt16LE(width, 6); data.writeUInt16LE(height, 8);
  return webpChunk('VP8 ', data);
}
function vp8l(width, height, version = 0) {
  const data = Buffer.alloc(6); data[0] = 0x2f; data.writeUInt32LE(((width - 1) | ((height - 1) << 14) | (version << 29)) >>> 0, 1);
  return webpChunk('VP8L', data);
}
function vp8x(width, height, flags = 0) {
  const data = Buffer.alloc(10); data[0] = flags; data.writeUIntLE(width - 1, 4, 3); data.writeUIntLE(height - 1, 7, 3);
  return webpChunk('VP8X', data);
}
const builders = [
  ['image/png', png], ['image/jpeg', jpeg], ['image/gif', gif],
  ['image/webp', (w, h) => riff([vp8(w, h)])],
  ['image/webp', (w, h) => riff([vp8l(w, h)])],
  ['image/webp', (w, h) => riff([vp8x(w, h), vp8(w, h)])]
];

test('ordinary encoded PNG, JPEG, GIF and WebP remain supported', () => {
  // JPEG/GIF were encoded from a locally generated 3x2 solid PNG by macOS sips.
  const jpegBytes = Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAA6ADAAQAAAABAAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAgADAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+T6KKK/UD87P/9k=', 'base64');
  const gifBytes = Buffer.from('R0lGODdhAwACAJEAAAAAADxaeP///wAAACH5BAQAAAAALAAAAAADAAIAAAICjF8AOw==', 'base64');
  const webpBytes = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
  assert.deepEqual(validate(png(1, 1), 'image/png'), { width: 1, height: 1 });
  assert.deepEqual(validate(jpegBytes, 'image/jpeg'), { width: 3, height: 2 });
  assert.deepEqual(validate(gifBytes, 'image/gif'), { width: 3, height: 2 });
  assert.deepEqual(validate(webpBytes, 'image/webp'), { width: 1, height: 1 });
});

test('all header types enforce positive dimensions, both side limits and the exact pixel budget', () => {
  assert.equal(MAX_IMAGE_SIDE, 8192); assert.equal(MAX_IMAGE_PIXELS, 16_000_000);
  for (const [mime, build] of builders) {
    assert.deepEqual(validate(build(4000, 4000), mime), { width: 4000, height: 4000 });
    assert.deepEqual(validate(build(8192, 1), mime), { width: 8192, height: 1 });
    assert.deepEqual(validate(build(1, 8192), mime), { width: 1, height: 8192 });
    for (const [width, height] of [[8193, 1], [1, 8193], [4001, 4000]]) assert.throws(() => validate(build(width, height), mime), tooLarge);
  }
  for (const [mime, build] of builders.slice(0, 4)) for (const dims of [[0, 1], [1, 0]]) assert.throws(() => validate(build(...dims), mime), invalid);
});

test('the small, valid compressed PNG reproducer is refused without raster decompression', async () => {
  const width = 10240, height = 10240, encoder = zlib.createDeflate({ level: 9 }), parts = [];
  encoder.on('data', part => parts.push(part));
  const ended = once(encoder, 'end'), row = Buffer.alloc(1 + width * 4);
  for (let line = 0; line < height; line++) if (!encoder.write(row)) await once(encoder, 'drain');
  encoder.end(); await ended;
  const image = png(width, height, [], Buffer.concat(parts));
  assert.ok(image.length < 4 * 1024 * 1024); assert.equal(width * height * 4, 419430400);
  assert.throws(() => validate(image, 'image/png'), tooLarge);
});

test('truncated files, MIME mismatches and broken container lengths fail closed', () => {
  for (const [mime, build] of builders) {
    const image = build(3, 2);
    for (let length = 0; length < image.length; length++) assert.throws(() => validate(image.subarray(0, length), mime), invalid);
    assert.throws(() => validate(image, 'image/svg+xml'), invalid);
  }
  assert.throws(() => validate('not a buffer', 'image/png'), invalid);
  for (const mime of ['__proto__', 'toString', null, {}]) assert.throws(() => validate(png(1, 1), mime), invalid);
  assert.throws(() => validate(gif(1, 1), 'image/png'), invalid);
});

test('PNG validates IHDR structure and refuses APNG rather than trusting only its canvas', () => {
  const badCrc = png(1, 1); badCrc[29] ^= 1; assert.throws(() => validate(badCrc, 'image/png'), invalid);
  const badLength = png(1, 1); badLength.writeUInt32BE(12, 8); assert.throws(() => validate(badLength, 'image/png'), invalid);
  for (const type of ['acTL', 'fcTL', 'fdAT']) assert.throws(() => validate(png(1, 1, [pngChunk(type, Buffer.alloc(26))]), 'image/png'), animated);
  const duplicate = png(1, 1, [pngChunk('IHDR', Buffer.alloc(13))]); assert.throws(() => validate(duplicate, 'image/png'), invalid);
  const trailing = Buffer.concat([png(1, 1), pngChunk('IDAT', Buffer.from([1]))]); assert.throws(() => validate(trailing, 'image/png'), invalid);
});

test('GIF checks actual image descriptors, extension boundaries and rejects additional frames', () => {
  assert.deepEqual(validate(gif(3, 2, undefined, Buffer.from([0x21, 0xfe, 3, 97, 98, 99, 0])), 'image/gif'), { width: 3, height: 2 });
  assert.throws(() => validate(gif(1, 1, [gifFrame(10240, 10240)]), 'image/gif'), tooLarge);
  assert.throws(() => validate(gif(3, 2, [gifFrame(3, 2, 1)]), 'image/gif'), invalid);
  assert.throws(() => validate(gif(1, 1, [gifFrame(1, 1), gifFrame(1, 1)]), 'image/gif'), animated);
  assert.throws(() => validate(gif(1, 1, [], Buffer.from([0x21, 0xfe, 255])), 'image/gif'), invalid);
});

test('JPEG parses segment boundaries, progressive SOF and escaped scan bytes without reading APP payload markers', () => {
  const fakeSof = jpeg(65535, 65535).subarray(2, 15);
  assert.deepEqual(validate(jpeg(3, 2, [segment(0xe1, fakeSof)]), 'image/jpeg'), { width: 3, height: 2 });
  const progressive = jpeg(3, 2); progressive[3] = 0xc2;
  assert.deepEqual(validate(progressive, 'image/jpeg'), { width: 3, height: 2 });
  const temporaryMarker = jpeg(3, 2); temporaryMarker[temporaryMarker.length - 4] = 0x01;
  assert.deepEqual(validate(temporaryMarker, 'image/jpeg'), { width: 3, height: 2 });
  const duplicate = jpeg(3, 2, [jpeg(3, 2).subarray(2, 15)]); assert.throws(() => validate(duplicate, 'image/jpeg'), invalid);
  for (const length of [0, 1, 65535]) { const broken = jpeg(3, 2); broken.writeUInt16BE(length, 4); assert.throws(() => validate(broken, 'image/jpeg'), invalid); }
  const countMismatch = jpeg(3, 2); countMismatch[11] = 2; assert.throws(() => validate(countMismatch, 'image/jpeg'), invalid);
  assert.throws(() => validate(jpeg(3, 2, [segment(0xdc, Buffer.from([0, 2]))]), 'image/jpeg'), invalid);
});

test('WebP checks VP8/VP8L bitstream headers against VP8X and refuses animation or hidden oversized frames', () => {
  assert.deepEqual(validate(riff([vp8x(3, 2), vp8l(3, 2), webpChunk('EXIF', Buffer.from([1]))]), 'image/webp'), { width: 3, height: 2 });
  assert.throws(() => validate(riff([vp8x(1, 1), vp8(8193, 1)]), 'image/webp'), tooLarge);
  assert.throws(() => validate(riff([vp8x(1, 1), vp8(2, 2)]), 'image/webp'), invalid);
  assert.throws(() => validate(riff([vp8(1, 1), vp8x(1, 1)]), 'image/webp'), invalid);
  assert.throws(() => validate(riff([vp8l(1, 1, 1)]), 'image/webp'), invalid);
  assert.throws(() => validate(riff([vp8x(1, 1, 2), vp8(1, 1)]), 'image/webp'), animated);
  for (const type of ['ANIM', 'ANMF']) assert.throws(() => validate(riff([vp8x(1, 1), webpChunk(type, Buffer.alloc(16)), vp8(1, 1)]), 'image/webp'), animated);
  assert.throws(() => validate(riff([vp8x(1, 1)]), 'image/webp'), invalid);
  assert.throws(() => validate(riff([vp8(1, 1), vp8l(1, 1)]), 'image/webp'), invalid);
  const badPadding = riff([vp8(1, 1)]); badPadding[badPadding.length - 1] = 1; assert.throws(() => validate(badPadding, 'image/webp'), invalid);
});
