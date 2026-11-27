import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { validateImage } from './admin.js';
import { parse } from 'yaml';
import matter from 'gray-matter';

const origin = 'https://blog.nakanashi.com';
const env = { ADMIN_ORIGIN: origin, ADMIN_PASSWORD: 'test-password-never-deploy-this', GITHUB_TOKEN: 'test-token',
  ADMIN_LOGIN_LIMITER: { limit: async () => ({ success: true }) }, ASSETS: { fetch: async () => new Response('blog') } };
const request = (path, data, cookie = '', headers = {}) => new Request(`${origin}/api/admin/${path}`, {
  method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }), Cookie: cookie, ...headers },
  ...(data === undefined ? {} : { body: JSON.stringify(data) }),
});
async function login() {
  const response = await worker.fetch(request('login', { password: env.ADMIN_PASSWORD }), env);
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie'); assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  return cookie.split(';')[0];
}
const article = () => ({ path: 'src/content/posts/trial.md', sha: '', body: '# 正文\n\n你好，世界！',
  metadata: { title: '中文标题', published: '2026-11-27', tags: ['生活'], category: '随笔' }, images: [] });

test('authentication, origin, cookie forgery and fail-closed configuration', async () => {
  assert.equal((await worker.fetch(request('posts'), env)).status, 401);
  assert.equal((await worker.fetch(request('login', { password: 'wrong' }), env)).status, 401);
  assert.equal((await worker.fetch(request('login', { password: env.ADMIN_PASSWORD }, '', { Origin: 'https://evil.test' }), env)).status, 403);
  const cookie = await login();
  assert.equal((await worker.fetch(request('session', undefined, cookie), env)).status, 200);
  assert.equal((await worker.fetch(request('session', undefined, cookie + 'forged'), env)).status, 401);
  assert.equal((await worker.fetch(request('session', undefined, cookie), { ...env, ADMIN_PASSWORD: 'rotated-password-long-enough' })).status, 401);
  assert.equal((await worker.fetch(request('login', { password: env.ADMIN_PASSWORD }), { ...env, ADMIN_PASSWORD: '' })).status, 503);
  assert.equal((await worker.fetch(request('login', { password: env.ADMIN_PASSWORD }), { ...env, ADMIN_LOGIN_LIMITER: { limit: async () => ({ success: false }) } })).status, 429);
  assert.equal((await worker.fetch(request('posts', undefined, cookie), { ...env, GITHUB_TOKEN: '' })).status, 503);
});

test('publication validates dates, paths and images before repository calls', async () => {
  const cookie = await login();
  for (const path of ['src/content/posts/../config/a.md', 'src/content/posts/a.mdx', '.github/workflows/a.md', 'src/content/posts/%2e%2e/a.md']) {
    assert.equal((await worker.fetch(request('publish', { ...article(), path }, cookie), env)).status, 400);
  }
  const invalid = article(); invalid.metadata.published = '2026-02-31';
  assert.equal((await worker.fetch(request('publish', invalid, cookie), env)).status, 400);
  assert.throws(() => validateImage({ path: 'public/uploads/x.png', content: btoa('<script>bad</script>') }));
  assert.throws(() => validateImage({ path: 'public/uploads/x.svg', content: 'AAAA' }));
  assert.throws(() => validateImage({ path: 'src/config/x.png', content: 'AAAA' }));
  assert.equal(validateImage({ path: 'public/uploads/test.png', content: 'iVBORw0KGgo=' }), 8);
});

test('new article and images are committed atomically; dates are compatible with Astro', async () => {
  const cookie = await login(); const originalFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => {
    const payload = options.body ? JSON.parse(options.body) : null; calls.push({ url, payload, method: options.method });
    const path = new URL(url).pathname;
    if (path.endsWith('/git/ref/heads/master')) return Response.json({ object: { sha: 'head1' } });
    if (path.endsWith('/git/commits/head1')) return Response.json({ tree: { sha: 'tree1' } });
    if (path.endsWith('/git/trees/tree1')) return Response.json({ tree: [], truncated: false });
    if (path.endsWith('/git/blobs')) return Response.json({ sha: 'image1' });
    if (path.endsWith('/git/trees')) return Response.json({ sha: 'tree2' });
    if (path.endsWith('/git/commits')) return Response.json({ sha: 'head2' });
    if (path.endsWith('/git/refs/heads/master')) return Response.json({ object: { sha: 'head2' } });
    throw Error(`Unexpected GitHub call ${url}`);
  };
  try {
    const input = article(); input.images = [{ path: 'public/uploads/test.png', content: 'iVBORw0KGgo=' }];
    const response = await worker.fetch(request('publish', input, cookie), env);
    assert.equal(response.status, 200, await response.clone().text());
    const writeTree = calls.find(c => c.url.endsWith('/git/trees')).payload;
    assert.equal(writeTree.tree.length, 2); assert.equal(writeTree.base_tree, 'tree1');
    const source = writeTree.tree[0].content;
    assert.equal(matter(source).data.title, '中文标题'); assert.ok(matter(source).data.published instanceof Date);
    assert.deepEqual(parse(source.split('---')[1]).tags, ['生活']);
    assert.equal(calls.filter(c => c.url.endsWith('/git/refs/heads/master')).length, 1);
    assert.deepEqual(calls.at(-1).payload, { sha: 'head2', force: false });
  } finally { globalThis.fetch = originalFetch; }
});

test('stale article SHA refuses to overwrite repository content', async () => {
  const cookie = await login(); const originalFetch = globalThis.fetch; let wrote = false;
  globalThis.fetch = async (url, options) => {
    if (options.method) wrote = true;
    if (url.includes('/git/ref/')) return Response.json({ object: { sha: 'head' } });
    if (url.includes('/git/commits/')) return Response.json({ tree: { sha: 'tree' } });
    return Response.json({ tree: [{ path: article().path, sha: 'someone-elses-version', type: 'blob' }] });
  };
  try { assert.equal((await worker.fetch(request('publish', article(), cookie), env)).status, 409); assert.equal(wrote, false); }
  finally { globalThis.fetch = originalFetch; }
});

test('admin shell is non-cacheable and not embeddable; blog assets keep normal caching', async () => {
  const response = await worker.fetch(new Request(`${origin}/admin/`), env);
  assert.equal(response.headers.get('x-frame-options'), 'DENY'); assert.equal(response.headers.get('cache-control'), 'no-store');
  const normal = await worker.fetch(new Request(`${origin}/`), env);
  assert.equal(normal.headers.get('cache-control'), null);
});
