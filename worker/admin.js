import { parse, stringify } from 'yaml';

const COOKIE = '__Host-firefly_admin';
const POST_DIR = 'src/content/posts/';
const IMAGE_DIR = 'public/uploads/';
const MAX_BODY = 16 * 1024 * 1024;
const encoder = new TextEncoder();
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...headers },
});
const base64 = (bytes) => { let result = ''; for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(result); };
const unbase64 = (value) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const b64url = (bytes) => base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
async function key(password) {
  return crypto.subtle.importKey('raw', encoder.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function equal(a, b) {
  const [aa, bb] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', encoder.encode(s))));
  return new Uint8Array(aa).reduce((v, n, i) => v | (n ^ new Uint8Array(bb)[i]), 0) === 0;
}
async function session(env, origin) {
  const payload = b64url(encoder.encode(JSON.stringify({ exp: Date.now() + 8 * 3600_000, origin, nonce: crypto.randomUUID() })));
  const signature = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env.ADMIN_PASSWORD), encoder.encode(payload))));
  return `${payload}.${signature}`;
}
async function authenticated(request, env) {
  const value = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!value || value.length > 1000) return false;
  try {
    const [payload, signature, extra] = value.split('.');
    if (extra || !signature) return false;
    const bytes = unbase64(signature.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - signature.length % 4) % 4));
    if (!await crypto.subtle.verify('HMAC', await key(env.ADMIN_PASSWORD), bytes, encoder.encode(payload))) return false;
    const data = JSON.parse(new TextDecoder().decode(unbase64(payload.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - payload.length % 4) % 4))));
    return data.exp > Date.now() && data.origin === new URL(request.url).origin;
  } catch { return false; }
}
async function readJson(request, max = MAX_BODY) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, '请求格式不正确。');
  if (Number(request.headers.get('content-length') || 0) > max) fail(413, '内容过大，请减少图片数量或压缩图片。');
  const reader = request.body?.getReader();
  if (!reader) fail(400, '请求内容为空。');
  let size = 0; const parts = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
    if (size > max) { await reader.cancel(); fail(413, '内容过大，请减少图片数量或压缩图片。'); } parts.push(value); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const p of parts) { bytes.set(p, offset); offset += p.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, '请求内容无法读取。'); }
}
function repoConfig(env) {
  if (!env.GITHUB_TOKEN) fail(503, '后台尚未配置 GitHub 写入凭据，请站主完成配置。');
  return { repo: env.GITHUB_REPO || 'John-River/Firefly', branch: env.GITHUB_BRANCH || 'master' };
}
async function github(env, path, options = {}) {
  const { repo } = repoConfig(env);
  const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    ...options, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'Firefly-Admin', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    if (response.status === 409 || response.status === 422) fail(409, '仓库已发生变化，请保留本地草稿、刷新文章后重试。');
    if (response.status === 401 || response.status === 403) fail(502, 'GitHub 凭据无效、权限不足或请求额度已用尽，请检查配置。');
    if (response.status === 404) fail(404, 'GitHub 中未找到对应仓库、分支或文章。');
    fail(502, 'GitHub 暂时无法保存，请稍后重试。');
  }
  return response.json();
}
const send = (env, path, data, method = 'POST') => github(env, path, { method, body: JSON.stringify(data) });
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');
function validPostPath(path) {
  return typeof path === 'string' && path.startsWith(POST_DIR) && path.endsWith('.md') && path.length <= 240 &&
    !path.includes('\\') && !path.includes('%') && !path.includes('\0') && path.split('/').every(p => p && p !== '.' && p !== '..' && !p.startsWith('.'));
}
function text(value, name, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, `${name}为空或长度不正确。`);
  return value.trim();
}
function date(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, `${name}不正确。`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(400, `${name}不正确。`);
  return value;
}
function frontmatter(source) {
  const match = source.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) fail(400, '文章缺少有效的 YAML 元数据，暂不支持在线编辑。');
  const data = parse(match[1], { maxAliasCount: 30 });
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, '文章元数据格式不正确。');
  return { metadata: data, body: source.replace(/^\uFEFF/, '').slice(match[0].length) };
}
async function tree(env) {
  const { branch } = repoConfig(env);
  const ref = await github(env, `git/ref/heads/${encodePath(branch)}`);
  const commit = await github(env, `git/commits/${ref.object.sha}`);
  const files = await github(env, `git/trees/${commit.tree.sha}?recursive=1`);
  if (files.truncated) fail(503, '仓库文件数量超出试行版支持范围。');
  return { head: ref.object.sha, tree: commit.tree.sha, files: files.tree };
}
async function post(env, path, ref) {
  if (!validPostPath(path)) fail(400, '只支持文章目录内的 Markdown 文件。');
  const { branch } = repoConfig(env);
  const file = await github(env, `contents/${encodePath(path)}?ref=${encodeURIComponent(ref || branch)}`);
  if (file.encoding !== 'base64' || file.size > 1024 * 1024) fail(400, '文章超过在线编辑大小限制。');
  return { path, sha: file.sha, ...frontmatter(new TextDecoder().decode(unbase64(file.content.replace(/\s/g, '')))) };
}
export function validateImage(image) {
  if (!image || typeof image.path !== 'string' || !/^public\/uploads\/[a-z0-9-]+\.(png|jpg|webp|gif)$/.test(image.path) ||
    typeof image.content !== 'string' || image.content.length > 7 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.content)) fail(400, '图片格式或大小不正确。');
  let bytes; try { bytes = unbase64(image.content); } catch { fail(400, '图片内容无效。'); }
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) fail(400, '每张图片最大支持 5 MB。');
  const head = Array.from(bytes.subarray(0, 12));
  const extension = image.path.split('.').pop();
  const ok = extension === 'png' ? head.slice(0, 8).join() === '137,80,78,71,13,10,26,10' :
    extension === 'jpg' ? head[0] === 255 && head[1] === 216 && head[2] === 255 :
    extension === 'gif' ? new TextDecoder().decode(bytes.subarray(0, 6)).match(/^GIF8[79]a$/) :
    new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP';
  if (!ok) fail(400, '图片真实格式与扩展名不匹配。');
  return bytes.length;
}
async function publish(env, input) {
  const path = input.path;
  if (!validPostPath(path)) fail(400, '文章保存路径不正确。');
  const body = text(input.body, '正文', 800_000, true);
  const m = input.metadata || {};
  const metadata = {
    title: text(m.title, '标题', 200, true), published: date(m.published, '发布日期'),
    updated: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }),
    description: text(m.description || '', '摘要', 1000), category: text(m.category || '', '分类', 100),
    author: text(m.author || '', '作者', 100), image: text(m.image || '', '封面', 500),
    tags: Array.isArray(m.tags) && m.tags.length <= 30 ? m.tags.map(t => text(t, '标签', 50, true)) : fail(400, '最多支持 30 个标签。'),
    pinned: m.pinned === true, comment: m.comment !== false, draft: false,
  };
  if (metadata.image && !/^(\/uploads\/|https:\/\/)/.test(metadata.image) && metadata.image !== 'api' && !input.sha) fail(400, '封面请使用上传图片或 HTTPS 图片地址。');
  const images = input.images || [];
  if (!Array.isArray(images) || images.length > 20) fail(400, '一次最多发布 20 张新图片。');
  let total = 0; const imagePaths = new Set();
  for (const image of images) {
    total += validateImage(image);
    if (imagePaths.has(image.path)) fail(400, '图片路径重复。'); imagePaths.add(image.path);
  }
  if (total > 10 * 1024 * 1024) fail(400, '新图片总大小不能超过 10 MB。');
  const snapshot = await tree(env);
  const existing = snapshot.files.find(f => f.path === path);
  if ((existing?.sha || '') !== (input.sha || '')) fail(409, '文章已更新或文件名已存在，请重新打开文章后编辑。');
  let original = {};
  if (existing) original = (await post(env, path, snapshot.head)).metadata;
  // Preserve metadata not exposed in the editor (e.g. license and article passwords).
  const content = `---\n${stringify({ ...original, ...metadata }, { lineWidth: 0 })}---\n\n${body}\n`;
  const entries = [{ path, mode: '100644', type: 'blob', content }];
  for (const image of images) {
    if (snapshot.files.some(f => f.path === image.path)) fail(409, '图片名称已存在，请重新插入图片。');
    const blob = await send(env, 'git/blobs', { content: image.content, encoding: 'base64' });
    entries.push({ path: image.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const nextTree = await send(env, 'git/trees', { base_tree: snapshot.tree, tree: entries });
  const commit = await send(env, 'git/commits', { message: `${existing ? '更新' : '发布'}文章：${metadata.title}`, tree: nextTree.sha, parents: [snapshot.head] });
  const { branch, repo } = repoConfig(env);
  // Non-fast-forward updates are rejected; never overwrite a concurrent commit.
  await send(env, `git/refs/heads/${encodePath(branch)}`, { sha: commit.sha, force: false }, 'PATCH');
  return { commit: commit.sha, commitUrl: `https://github.com/${repo}/commit/${commit.sha}`, path,
    sha: nextTree.sha, url: `/posts/${path.slice(POST_DIR.length, -3).replace(/\/index$/, '')}/`, state: 'submitted' };
}
async function api(request, env) {
  const url = new URL(request.url);
  if (url.origin !== env.ADMIN_ORIGIN) fail(403, '请从博客正式域名访问后台。');
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 10) fail(503, '站主后台尚未设置登录密码，请在 Cloudflare 配置后使用。');
  const endpoint = url.pathname.slice('/api/admin/'.length);
  if (request.method !== 'GET') {
    if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') fail(403, '请求来源不正确，请刷新页面。');
  }
  if (endpoint === 'login' && request.method === 'POST') {
    if (!env.ADMIN_LOGIN_LIMITER) fail(503, '后台登录限流尚未配置。');
    const { success } = await env.ADMIN_LOGIN_LIMITER.limit({ key: `login:${request.headers.get('cf-connecting-ip') || 'unknown'}` });
    if (!success) return json({ error: '尝试次数过多，请一分钟后重试。' }, 429, { 'Retry-After': '60' });
    const input = await readJson(request, 2048);
    if (typeof input.password !== 'string' || !await equal(input.password, env.ADMIN_PASSWORD)) fail(401, '密码不正确。');
    return json({ authenticated: true }, 200, { 'Set-Cookie': `${COOKIE}=${await session(env, url.origin)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800` });
  }
  if (endpoint === 'logout' && request.method === 'POST') return json({ authenticated: false }, 200, {
    'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
  });
  if (!await authenticated(request, env)) fail(401, '请先登录站主后台。');
  if (endpoint === 'session' && request.method === 'GET') return json({ authenticated: true, publishingReady: Boolean(env.GITHUB_TOKEN) });
  if (endpoint === 'posts' && request.method === 'GET') {
    const snapshot = await tree(env);
    return json({ posts: snapshot.files.filter(f => f.type === 'blob' && validPostPath(f.path)).map(f => ({ path: f.path, sha: f.sha })) });
  }
  if (endpoint === 'post' && request.method === 'GET') return json(await post(env, url.searchParams.get('path')));
  if (endpoint === 'publish' && request.method === 'POST') return json(await publish(env, await readJson(request)));
  fail(404, '接口不存在。');
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/admin/')) {
      try { return await api(request, env); }
      catch (error) { return json({ error: error instanceof HttpError ? error.message : '后台暂时不可用，请稍后重试。' }, error instanceof HttpError ? error.status : 500); }
    }
    const response = await env.ASSETS.fetch(request);
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      const result = new Response(response.body, response);
      result.headers.set('Cache-Control', 'no-store');
      result.headers.set('X-Robots-Tag', 'noindex, nofollow');
      result.headers.set('X-Frame-Options', 'DENY');
      result.headers.set('Referrer-Policy', 'same-origin');
      result.headers.set('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
      return result;
    }
    return response;
  },
};
