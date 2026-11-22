// A flash through the agent API, against a scripted holder.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/shared/protocol.ts';
import { logFileLines, makeBuild, md5, readFlasherArgs, ScriptedHolder, sleep, startTestBench, type TestBench } from './helpers.ts';

let bench: TestBench;

beforeEach(async () => {
  bench = await startTestBench();
});

afterEach(async () => {
  await bench.close();
});

function flashJob(job: Job): Extract<Job, { kind: 'flash' }> {
  if (job.kind !== 'flash') throw new Error(`expected a flash job, got ${job.kind}`);
  return job;
}

describe('a flash', () => {
  it('names exactly the images of flasher_args.json, serves their exact bytes, and answers chip, MAC and cursor', async () => {
    const holder = await ScriptedHolder.connect(bench);
    const build = makeBuild(path.join(bench.workRoot, 'app', 'build'));
    const call = bench.api('POST', '/flash', { build_dir: build.dir });

    const { jobId, job: j } = await holder.nextJob();
    const job = flashJob(j);
    const args = readFlasherArgs();
    expect(job.chip).toBe(args.extra_esptool_args.chip);
    expect(job.flash).toEqual({ mode: 'dio', freq: '80m', size: '2MB' });
    const expected = Object.entries(args.flash_files)
      .map(([offset, name]) => ({ offset: parseInt(offset, 16), name }))
      .sort((a, b) => a.offset - b.offset);
    expect(job.images.map(({ offset, name }) => ({ offset, name }))).toEqual(expected);

    // A rebuild while the job runs changes nothing the holder is served
    fs.writeFileSync(path.join(build.dir, 'hello_world.bin'), 'rebuilt');

    for (const im of job.images) {
      expect(im.url).toBe(`/jobs/${jobId}/images/${job.images.indexOf(im)}`);
      const res = await fetch(bench.pageUrl(im.url));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.equals(build.images[im.name] ?? Buffer.alloc(0))).toBe(true);
      expect(im.size).toBe(bytes.length);
      expect(im.md5).toBe(md5(bytes));
    }
    expect((await fetch(bench.pageUrl(`/jobs/${jobId}/images/${job.images.length}`))).status).toBe(404);
    expect((await fetch(bench.pageUrl(`/jobs/${'0'.repeat(32)}/images/0`))).status).toBe(404);

    expect(bench.hub.status().job).toMatchObject({ kind: 'flash' });
    holder.send({ t: 'progress', jobId, phase: 'writing', image: 1, written: 100, total: 200 });
    holder.log('ESP-ROM:esp32s3-20210327\r\n');
    await sleep(20);
    expect(bench.hub.status().job?.progress).toEqual({ phase: 'writing', image: 1, written: 100, total: 200 });
    holder.result(jobId, { ok: true, chip: 'ESP32-S3', mac: 'dc:da:0c:11:22:33' });

    const r = await call;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ chip: 'ESP32-S3', mac: 'dc:da:0c:11:22:33', cursor: expect.any(Number), seconds: expect.any(Number) });

    // The images go with the job
    expect((await fetch(bench.pageUrl(job.images[0]?.url ?? ''))).status).toBe(404);
    const lines = logFileLines(bench);
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^\\S+ ${r.body.cursor} = flash started: ${build.dir} \\(esp32s3, 0x0 bootloader/bootloader.bin, 0x8000 partition_table/partition-table.bin, 0x10000 hello_world.bin\\)$`)));
    expect(lines).toContainEqual(expect.stringMatching(/ \| ESP-ROM:esp32s3-20210327$/));
    expect(lines).toContainEqual(expect.stringMatching(/ = flash done in [\d.]+ s: ESP32-S3 dc:da:0c:11:22:33$/));
    expect(bench.hub.status().job).toBeNull();
  });

  it('that fails answers flash_failed with esptool\'s message', async () => {
    const holder = await ScriptedHolder.connect(bench);
    const build = makeBuild(path.join(bench.workRoot, 'build'));
    const call = bench.api('POST', '/flash', { build_dir: build.dir });
    const { jobId } = await holder.nextJob();
    holder.result(jobId, { ok: false, code: 'flash_failed', message: 'A fatal error occurred: MD5 of file does not match data in flash!' });
    const r = await call;
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ error: 'flash_failed', message: 'A fatal error occurred: MD5 of file does not match data in flash!', cursor: expect.any(Number) });
    expect(logFileLines(bench)).toContainEqual(expect.stringMatching(/ = flash failed: flash_failed: A fatal error occurred/));
    expect(bench.hub.status().job).toBeNull();
  });

  it('on the wrong chip answers wrong_chip, and the job carries the build\'s chip', async () => {
    const holder = await ScriptedHolder.connect(bench);
    const build = makeBuild(path.join(bench.workRoot, 'build'), { chip: 'esp32c3' });
    const call = bench.api('POST', '/flash', { build_dir: build.dir });
    const { jobId, job } = await holder.nextJob();
    expect(flashJob(job).chip).toBe('esp32c3');
    holder.result(jobId, { ok: false, code: 'wrong_chip', message: 'the device is an ESP32-S3, the build is for esp32c3', chip: 'ESP32-S3' });
    const r = await call;
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'wrong_chip', chip: 'ESP32-S3' });
  });

  it('that times out answers timed_out, and keeps the slot until the holder answers', async () => {
    const holder = await ScriptedHolder.connect(bench);
    const build = makeBuild(path.join(bench.workRoot, 'build'));
    const call = bench.api('POST', '/flash', { build_dir: build.dir, timeout: 0.2 });
    const { jobId } = await holder.nextJob();
    const r = await call;
    expect(r.status).toBe(504);
    expect(r.body).toMatchObject({ error: 'timed_out', cursor: expect.any(Number) });
    expect(bench.hub.status().job).toMatchObject({ kind: 'flash', timedOut: true });

    const busy = await bench.api('POST', '/reset');
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe('busy');

    holder.result(jobId, { ok: true, chip: 'ESP32-S3' });
    await sleep(30);
    expect(bench.hub.status().job).toBeNull();
    expect(logFileLines(bench)).toContainEqual(expect.stringMatching(/ = flash answered after its time-out: ok$/));

    const reset = bench.api('POST', '/reset');
    const next = await holder.nextJob();
    expect(next.job).toEqual({ kind: 'reset' });
    holder.result(next.jobId, { ok: true });
    expect((await reset).status).toBe(200);
  });

  it('that times out gives the slot back after abandonMs when the holder never answers', async () => {
    await bench.close();
    bench = await startTestBench({ hub: { abandonMs: 200 } });
    const holder = await ScriptedHolder.connect(bench);
    const build = makeBuild(path.join(bench.workRoot, 'build'));
    const call = bench.api('POST', '/flash', { build_dir: build.dir, timeout: 0.1 });
    await holder.nextJob();
    expect((await call).status).toBe(504);
    expect((await bench.api('POST', '/reset')).status).toBe(409);
    await sleep(250);
    expect(bench.hub.status().job).toBeNull();
    expect(logFileLines(bench)).toContainEqual(expect.stringMatching(/ = flash abandoned: the holder never answered$/));
    const reset = bench.api('POST', '/reset');
    const next = await holder.nextJob();
    holder.result(next.jobId, { ok: true });
    expect((await reset).status).toBe(200);
  });

  it('ends with no_holder when the holder drops in the middle', async () => {
    const holder = await ScriptedHolder.connect(bench);
    const build = makeBuild(path.join(bench.workRoot, 'build'));
    const call = bench.api('POST', '/flash', { build_dir: build.dir });
    const { job } = await holder.nextJob();
    holder.ws.terminate();
    const r = await call;
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: 'no_holder', cursor: expect.any(Number) });
    expect(r.body.message).toMatch(/unknown state/);
    expect(bench.hub.status().holder.connected).toBe(false);
    expect(bench.hub.status().job).toBeNull();
    expect((await fetch(bench.pageUrl(flashJob(job).images[0]?.url ?? ''))).status).toBe(404);
    expect(logFileLines(bench)).toContainEqual(expect.stringMatching(/ = holder disconnected$/));
  });

  it('is refused with no_holder when no holder is connected', async () => {
    const build = makeBuild(path.join(bench.workRoot, 'build'));
    const r = await bench.api('POST', '/flash', { build_dir: build.dir });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('no_holder');
  });

  it('is refused with busy while another runs', async () => {
    const holder = await ScriptedHolder.connect(bench);
    const build = makeBuild(path.join(bench.workRoot, 'build'));
    const first = bench.api('POST', '/flash', { build_dir: build.dir });
    const { jobId } = await holder.nextJob();
    const second = await bench.api('POST', '/flash', { build_dir: build.dir });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('busy');
    expect((await bench.api('POST', '/console', { line: 'help' })).status).toBe(409);
    holder.result(jobId, { ok: true });
    expect((await first).status).toBe(200);
    expect(holder.hasJob()).toBe(false);
  });

  it('is refused with port_not_open when the holder has no port', async () => {
    await ScriptedHolder.connect(bench, { port: null });
    const build = makeBuild(path.join(bench.workRoot, 'build'));
    const r = await bench.api('POST', '/flash', { build_dir: build.dir });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: 'port_not_open', message: "the holder's port is not chosen" });
  });
});

describe('the build directory', () => {
  beforeEach(async () => {
    await ScriptedHolder.connect(bench);
  });

  async function refused(buildDir: unknown, pattern: RegExp) {
    const r = await bench.api('POST', '/flash', { build_dir: buildDir });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_build_dir');
    expect(r.body.message).toMatch(pattern);
    expect(bench.hub.status().job).toBeNull();
  }

  it('is refused outside the work root', async () => {
    const outside = makeBuild(path.join(bench.root, 'elsewhere', 'build'));
    await refused(outside.dir, /must be under/);
  });

  it('is refused when a symlink under the work root leads outside it', async () => {
    const outside = makeBuild(path.join(bench.root, 'elsewhere', 'build'));
    fs.symlinkSync(outside.dir, path.join(bench.workRoot, 'link'));
    await refused(path.join(bench.workRoot, 'link'), /must be under/);
  });

  it('is refused when .. leads out of the work root', async () => {
    makeBuild(path.join(bench.root, 'elsewhere', 'build'));
    await refused(path.join(bench.workRoot, '..', 'elsewhere', 'build'), /must be under/);
  });

  it('is refused with an image missing', async () => {
    const build = makeBuild(path.join(bench.workRoot, 'build'), { omit: 'hello_world.bin' });
    await refused(build.dir, /image missing: hello_world.bin/);
  });

  it('is refused when an image lies outside the build directory', async () => {
    const build = makeBuild(path.join(bench.workRoot, 'build'));
    const args = readFlasherArgs();
    args.flash_files['0x10000'] = '../other.bin';
    fs.writeFileSync(path.join(bench.workRoot, 'other.bin'), 'x');
    fs.writeFileSync(path.join(build.dir, 'flasher_args.json'), JSON.stringify(args));
    await refused(build.dir, /image outside the build directory/);
  });

  it('is refused without flasher_args.json, when relative, missing or not given', async () => {
    const dir = path.join(bench.workRoot, 'empty');
    fs.mkdirSync(dir);
    await refused(dir, /has no flasher_args.json/);
    await refused('work/build', /absolute path/);
    await refused(path.join(bench.workRoot, 'nothing'), /does not exist/);
    await refused(undefined, /build_dir is required/);
  });

  it('is refused when flasher_args.json names no chip', async () => {
    const build = makeBuild(path.join(bench.workRoot, 'build'));
    const args = readFlasherArgs() as Partial<ReturnType<typeof readFlasherArgs>>;
    delete args.extra_esptool_args;
    fs.writeFileSync(path.join(build.dir, 'flasher_args.json'), JSON.stringify(args));
    await refused(build.dir, /names no chip/);
  });
});
