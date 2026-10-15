import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { ToolError } from '../core/contract.js';

export interface Region { name: string; x: number; y: number; width: number; height: number }
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function decodePng(bytes: Buffer): PNG {
  if (bytes.length > 10_000_000 || bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE) || bytes.subarray(12, 16).toString() !== 'IHDR') throw new ToolError('INVALID_IMAGE', 'Expected a PNG up to 10 MB');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 4_000_000) throw new ToolError('IMAGE_TOO_LARGE', 'PNG limit: 4 million pixels and 8192 pixels per side');
  try { return PNG.sync.read(bytes, { checkCRC: true }); }
  catch { throw new ToolError('INVALID_IMAGE', 'PNG decoding or checksum validation failed'); }
}

export function referenceBytes(input: { data_base64: string; sha256: string }): Buffer {
  const bytes = Buffer.from(input.data_base64, 'base64');
  if (bytes.toString('base64') !== input.data_base64) throw new ToolError('INVALID_IMAGE', 'Reference must use canonical Base64');
  if (createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new ToolError('IMAGE_HASH_MISMATCH', 'Reference SHA-256 does not match its bytes');
  return bytes;
}

export function comparePng(reference: Buffer, candidate: Buffer, threshold = 8, regions: Region[] = []) {
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) throw new ToolError('INVALID_ARGUMENTS', 'threshold must be an integer from 0 to 255');
  const a = decodePng(reference), b = decodePng(candidate);
  if (a.width !== b.width || a.height !== b.height) throw new ToolError('IMAGE_SIZE_MISMATCH', 'Images must have identical dimensions; no resizing or alignment is applied');
  const { width, height } = a;
  const diff = new PNG({ width, height });
  const deltas = new Uint8Array(width * height);
  const sums = new Uint16Array(width * height);
  for (let p = 0; p < deltas.length; p++) {
    const offset = p * 4;
    const alphaA = a.data[offset + 3]! / 255, alphaB = b.data[offset + 3]! / 255;
    let total = 0, max = 0, gray = 0;
    for (let c = 0; c < 3; c++) {
      // Compare visible RGB after compositing transparency on white.
      const av = Math.round(a.data[offset + c]! * alphaA + 255 * (1 - alphaA));
      const bv = Math.round(b.data[offset + c]! * alphaB + 255 * (1 - alphaB));
      const delta = Math.abs(av - bv); total += delta; max = Math.max(max, delta); gray += bv;
    }
    deltas[p] = max; sums[p] = total;
    const changed = max > threshold, shade = Math.round(gray / 3 * 0.35 + 255 * 0.65);
    diff.data[offset] = changed ? 230 : shade;
    diff.data[offset + 1] = changed ? 20 : shade;
    diff.data[offset + 2] = changed ? 130 : shade;
    diff.data[offset + 3] = 255;
  }
  const measure = (region: Region) => {
    const { x, y, width: w, height: h } = region;
    if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height) throw new ToolError('INVALID_REGION', 'Regions must lie entirely within the PNG');
    let changed = 0, sum = 0, left = width, top = height, right = -1, bottom = -1;
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
      const p = py * width + px; sum += sums[p]!;
      if (deltas[p]! > threshold) { changed++; left = Math.min(left, px); top = Math.min(top, py); right = Math.max(right, px); bottom = Math.max(bottom, py); }
    }
    return { total_pixels: w * h, changed_pixels: changed, changed_ratio: changed / (w * h), mae: sum / (w * h * 3),
      changed_bounds: changed ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null };
  };
  const metrics = { metric_version: 'rgb-white-v1', width, height, threshold,
    ...measure({ name: 'full', x: 0, y: 0, width, height }),
    regions: regions.map(region => ({ ...region, ...measure(region) })) };
  return { metrics, diff: PNG.sync.write(diff) };
}
