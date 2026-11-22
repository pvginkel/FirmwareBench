// Reads a build directory the agent names: the chip, the flash settings and the images of
// its `flasher_args.json`. Only those images are ever written, which is what keeps the
// device's provisioned `nvs` partition safe.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface BuildImage {
  offset: number;
  name: string;
  file: string;
  size: number;
  md5: string;
}

export interface Build {
  dir: string;
  chip: string;
  flash: { mode: string; freq: string; size: string };
  images: BuildImage[];
}

export class BadBuildDir extends Error {}

export async function readBuild(buildDir: unknown, workRoot: string): Promise<Build> {
  if (typeof buildDir !== 'string' || !buildDir) throw new BadBuildDir('build_dir is required');
  if (!path.isAbsolute(buildDir)) throw new BadBuildDir(`build_dir must be an absolute path: ${buildDir}`);
  const root = await realpathOr(workRoot, null);
  const dir = await realpathOr(buildDir, null);
  if (!dir) throw new BadBuildDir(`build_dir does not exist: ${buildDir}`);
  if (!root || !inside(dir, root)) throw new BadBuildDir(`build_dir must be under ${workRoot}: ${buildDir}`);

  let args: unknown;
  try {
    args = JSON.parse(await fs.readFile(path.join(dir, 'flasher_args.json'), 'utf8'));
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'has no flasher_args.json' : 'has an unreadable flasher_args.json';
    throw new BadBuildDir(`${buildDir} ${why}`);
  }
  const a = args as {
    flash_files?: Record<string, unknown>;
    flash_settings?: Record<string, unknown>;
    extra_esptool_args?: { chip?: unknown };
  };
  const chip = a.extra_esptool_args?.chip;
  if (typeof chip !== 'string' || !chip) throw new BadBuildDir('flasher_args.json names no chip');
  const files = a.flash_files;
  if (!files || typeof files !== 'object' || !Object.keys(files).length) {
    throw new BadBuildDir('flasher_args.json names no images');
  }
  const s = a.flash_settings ?? {};
  const flash = {
    mode: typeof s.flash_mode === 'string' ? s.flash_mode : 'keep',
    freq: typeof s.flash_freq === 'string' ? s.flash_freq : 'keep',
    size: typeof s.flash_size === 'string' ? s.flash_size : 'keep',
  };

  const images: BuildImage[] = [];
  for (const [offsetText, name] of Object.entries(files)) {
    if (!/^0x[0-9a-f]+$/i.test(offsetText)) throw new BadBuildDir(`flasher_args.json has an offset that is not hex: ${offsetText}`);
    if (typeof name !== 'string' || !name) throw new BadBuildDir(`flasher_args.json names no file at ${offsetText}`);
    const file = await realpathOr(path.resolve(dir, name), null);
    if (!file) throw new BadBuildDir(`image missing: ${name}`);
    if (!inside(file, dir)) throw new BadBuildDir(`image outside the build directory: ${name}`);
    const data = await fs.readFile(file);
    if (!data.length) throw new BadBuildDir(`image is empty: ${name}`);
    images.push({
      offset: parseInt(offsetText, 16),
      name,
      file,
      size: data.length,
      md5: crypto.createHash('md5').update(data).digest('hex'),
    });
  }
  images.sort((x, y) => x.offset - y.offset);
  return { dir, chip, flash, images };
}

function inside(p: string, root: string): boolean {
  return p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

async function realpathOr(p: string, fallback: null): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return fallback;
  }
}
