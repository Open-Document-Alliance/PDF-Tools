// A minimal, dependency-free RGBA-to-PNG encoder.
//
// The Windows system-render fallback gets a raw pixel buffer back from
// pdfium.dll, not a PNG: PDFium's C API renders into a bitmap, it does not
// encode image files. Every other renderer in this project either gets a
// ready-made PNG from its source (macOS's qlmanage writes one directly) or
// encodes through @napi-rs/canvas's toBuffer("image/png") — the very native
// binding this fallback exists because it is unavailable. Encoding PNG in
// pure JavaScript keeps the Windows fallback free of any second native
// dependency; correctness matters far more than compression ratio for an
// internal rendering tool, so every scanline uses filter type 0 (None) and
// compression is Node's built-in zlib deflate.
import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable = null;
function crcTableFor() {
  if (crcTable !== null) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(buffer) {
  const table = crcTableFor();
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

// Encodes a tightly packed RGBA buffer (width * height * 4 bytes, row-major,
// top-to-bottom, no padding) as an 8-bit-depth truecolor-with-alpha PNG.
export function encodeRgbaToPng(rgba, width, height) {
  if (!Buffer.isBuffer(rgba) && !(rgba instanceof Uint8Array)) {
    throw new TypeError("rgba must be a Buffer or Uint8Array.");
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new TypeError("width and height must be positive integers.");
  }
  const expectedBytes = width * height * 4;
  if (rgba.length !== expectedBytes) {
    throw new RangeError(
      `rgba length ${rgba.length} does not match ${width}x${height}x4 = ${expectedBytes}.`,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor with alpha
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const rgbaBuffer = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba);
  for (let row = 0; row < height; row += 1) {
    const rawOffset = row * (stride + 1);
    raw[rawOffset] = 0; // filter type: None
    rgbaBuffer.copy(raw, rawOffset + 1, row * stride, row * stride + stride);
  }
  const idatData = deflateSync(raw, { level: 6 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
