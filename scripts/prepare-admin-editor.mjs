import { createHash, timingSafeEqual } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pin the editor and publish its assets with the site, so writing does not
// depend on the visitor's connection to a third-party CDN.
const version = '4.0.1';
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = join(root, 'public/admin/vendor/vditor');
const marker = join(destination, 'version.json');
try {
  if (JSON.parse(await readFile(marker, 'utf8')).version === version) {
    console.log(`Vditor ${version}: local assets ready.`);
    process.exit(0);
  }
} catch { /* First build or an incomplete previous download. */ }

async function download(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

await mkdir(join(root, '.astro'), { recursive: true });
const stage = await mkdtemp(join(root, '.astro/admin-editor-'));
try {
  const metadata = JSON.parse((await download(`https://registry.npmjs.org/vditor/${version}`)).toString());
  if (metadata.name !== 'vditor' || metadata.version !== version ||
      metadata.dist?.tarball !== `https://registry.npmjs.org/vditor/-/vditor-${version}.tgz` ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.dist?.integrity || '')) {
    throw new Error('Unexpected Vditor package metadata.');
  }
  const archive = await download(metadata.dist.tarball);
  const expected = Buffer.from(metadata.dist.integrity.slice(7), 'base64');
  const actual = createHash('sha512').update(archive).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('Vditor archive integrity check failed.');
  }
  const tarball = join(stage, 'vditor.tgz');
  await writeFile(tarball, archive);
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split(/\r?\n/);
  if (entries.some(path => !path.startsWith('package/') || path.includes('\\') || path.split('/').includes('..'))) {
    throw new Error('Unexpected archive path.');
  }
  execFileSync('tar', ['-xzf', tarball, '-C', stage, 'package/dist']);
  for (const file of ['index.css', 'index.min.js', 'js/lute/lute.min.js']) {
    await readFile(join(stage, 'package/dist', file));
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(join(stage, 'package/dist'), join(destination, 'dist'), { recursive: true });
  await writeFile(marker, JSON.stringify({ version, integrity: metadata.dist.integrity }) + '\n');
  console.log(`Vditor ${version}: verified and copied to ${resolve(destination)}.`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
