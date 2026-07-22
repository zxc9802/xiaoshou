import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function cropCustomerAvatar(data: Buffer, box: { x: number; y: number; width: number; height: number }) {
  const pixelCoordinates = box.x > 1 || box.y > 1 || box.width > 1 || box.height > 1;
  if (!pixelCoordinates && (box.width < 0.015 || box.height < 0.015)) return undefined;
  const directory = await mkdtemp(join(tmpdir(), 'sales-customer-avatar-'));
  const input = join(directory, 'source');
  const output = join(directory, 'avatar.png');
  const grayscale = join(directory, 'avatar-gray.raw');
  try {
    await writeFile(input, data);
    const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', input], { timeout: 20_000 });
    const [width, height] = probe.stdout.trim().split('x').map(Number);
    if (!width || !height) return undefined;
    const cropWidth = Math.max(16, Math.min(width, Math.round(pixelCoordinates ? box.width : box.width * width)));
    const cropHeight = Math.max(16, Math.min(height, Math.round(pixelCoordinates ? box.height : box.height * height)));
    const x = Math.max(0, Math.min(width - cropWidth, Math.round(pixelCoordinates ? box.x : box.x * width)));
    const y = Math.max(0, Math.min(height - cropHeight, Math.round(pixelCoordinates ? box.y : box.y * height)));
    await run('ffmpeg', ['-y', '-i', input, '-vf', `crop=${cropWidth}:${cropHeight}:${x}:${y},scale=192:192:force_original_aspect_ratio=increase,crop=192:192`, '-frames:v', '1', output], { timeout: 30_000, maxBuffer: 1_000_000 });
    const avatar = await readFile(output);
    let fingerprint: string | undefined;
    try {
      await run('ffmpeg', ['-y', '-i', output, '-vf', 'scale=16:16,format=gray', '-f', 'rawvideo', grayscale], { timeout: 20_000, maxBuffer: 1_000_000 });
      const pixels = await readFile(grayscale);
      const average = pixels.reduce((sum, value) => sum + value, 0) / Math.max(1, pixels.length);
      let bits = '';
      for (const value of pixels) bits += value >= average ? '1' : '0';
      fingerprint = bits.match(/.{1,4}/g)?.map((part) => Number.parseInt(part.padEnd(4, '0'), 2).toString(16)).join('');
    } catch { /* Avatar display still works if fingerprint generation is unavailable. */ }
    return { data: avatar, fingerprint };
  } catch {
    return undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
