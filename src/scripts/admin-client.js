import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const $ = (id) => document.getElementById(id);
const PREFIX = 'src/content/posts/';
const CDN = `${window.location.origin}/admin/vendor/vditor`;
let editor, ready = false, images = [], activePath = '', sha = '', posts = [], dirty = false, timer, saving = Promise.resolve();
const fields = ['title', 'published', 'category', 'tags', 'author', 'image', 'description'];
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
function message(text, error = false, login = false) { const node = $(login ? 'login-message' : 'message'); node.textContent = text; node.classList.toggle('error', error); }
async function api(path, data) {
  const response = await fetch(`/api/admin/${path}`, { credentials: 'same-origin', cache: 'no-store',
    ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
  const result = await response.json().catch(() => ({ error: '后台接口暂未部署，请稍后再试。' }));
  if (!response.ok) {
    if (response.status === 401) { $('workspace').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true; }
    throw new Error(result.error || '请求失败，请稍后重试。');
  }
  return result;
}
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('firefly-writing', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function draftStore(method, value) {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', method === 'get' ? 'readonly' : 'readwrite');
    const store = transaction.objectStore('drafts');
    const request = method === 'put' ? store.put(value, 'current') : store[method]('current');
    transaction.oncomplete = () => resolve(request.result); transaction.onerror = () => reject(transaction.error);
  }); } finally { db.close(); }
}
const uri = (image) => `data:image/${image.path.endsWith('.jpg') ? 'jpeg' : image.path.split('.').pop()};base64,${image.content}`;
const publicPath = (image) => image.path.replace(/^public/, '');
function bodyValue() {
  let value = ready && editor ? editor.getValue() : $('markdown').value;
  for (const image of images) value = value.split(uri(image)).join(publicPath(image));
  return value;
}
function setBody(value) {
  for (const image of images) value = value.split(publicPath(image)).join(uri(image));
  if (ready && editor) editor.setValue(value); else { $('markdown').value = value; preview(); }
}
function collect() {
  const metadata = Object.fromEntries(fields.map(id => [id, $(id).value]));
  metadata.tags = $('tags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  metadata.pinned = $('pinned').checked; metadata.comment = $('comment').checked;
  return { path: activePath || `${PREFIX}${$('slug').value}.md`, sha, body: bodyValue(), metadata, images };
}
function queueSave() {
  if (!ready) return;
  dirty = true; clearTimeout(timer); $('draft-status').textContent = '正在保存本机草稿…';
  timer = setTimeout(saveDraft, 650);
}
function saveDraft() {
  const data = collect();
  saving = saving.catch(() => {}).then(() => draftStore('put', data)).then(() => {
    $('draft-status').textContent = `已自动保存到本机 · ${new Date().toLocaleTimeString('zh-CN')}`;
  }).catch(() => { $('draft-status').textContent = '本机草稿保存失败，请及时导出草稿。'; });
  return saving;
}
function preview() {
  $('markdown-preview').innerHTML = sanitizeHtml(marked.parse($('markdown').value), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, img: ['src', 'alt'] },
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  });
}
async function loadEditor() {
  try {
    await new Promise((resolve, reject) => {
      if (window.Vditor) { resolve(); return; }
      const script = document.createElement('script'); script.src = `${CDN}/dist/index.min.js`;
      script.onload = resolve; script.onerror = reject; document.head.append(script);
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('编辑器加载超时')), 20000);
      editor = new window.Vditor('editor', {
        cdn: CDN, mode: 'wysiwyg', lang: 'zh_CN', minHeight: 460, cache: { enable: false },
        toolbarConfig: { pin: true },
        placeholder: '从一句话开始…', counter: { enable: true },
        toolbar: ['headings', 'bold', 'italic', 'strike', '|', 'list', 'ordered-list', 'check', 'quote', 'line', '|', 'link', 'upload', 'table', 'code', 'inline-code', '|', 'undo', 'redo', 'edit-mode', 'both', 'fullscreen'],
        preview: { markdown: { sanitize: true }, hljs: { enable: false }, math: { engine: 'KaTeX' } },
        upload: { accept: 'image/*', multiple: true, handler: async files => { try { await addImages(files); return null; } catch (error) { message(error.message, true); return error.message; } } },
        input: queueSave, after: () => { clearTimeout(timeout); ready = true; resolve(); },
      });
    });
  } catch {
    editor?.destroy(); editor = null; $('editor').hidden = true; $('fallback').hidden = false; ready = true;
  }
}
function renderList() {
  const query = $('post-search').value.toLowerCase(); $('post-list').replaceChildren();
  for (const post of posts.filter(p => p.path.toLowerCase().includes(query))) {
    const button = document.createElement('button'); button.textContent = post.path.slice(PREFIX.length);
    button.addEventListener('click', () => openPost(post.path)); $('post-list').append(button);
  }
  if (!$('post-list').childElementCount) $('post-list').textContent = '暂无匹配的 Markdown 文章';
}
async function refresh() {
  try { posts = (await api('posts')).posts; renderList(); } catch (error) { message(error.message, true); }
}
function applyDraft(data) {
  images = data.images || []; activePath = data.sha ? data.path : ''; sha = data.sha || '';
  for (const id of fields) $(id).value = id === 'tags' ? (data.metadata.tags || []).join('，') : String(data.metadata[id] ?? '').slice(0, id === 'published' ? 10 : undefined);
  $('slug').value = data.path.slice(PREFIX.length, -3); $('slug').disabled = Boolean(activePath);
  $('pinned').checked = Boolean(data.metadata.pinned); $('comment').checked = data.metadata.comment !== false;
  setBody(data.body || '');
  $('publish').textContent = sha ? '发布更新' : '发布文章'; $('publish-result').hidden = true;
  $('publish').disabled = false;
}
async function openPost(path) {
  if (dirty && !confirm('打开其他文章会替换当前编辑内容。已保存的草稿也将被替换，是否继续？')) return;
  try {
    const data = await api(`post?path=${encodeURIComponent(path)}`); applyDraft(data); dirty = false;
    clearTimeout(timer); await saveDraft(); message('已打开文章。保存后会重新构建网站。');
    const category = data.metadata.category; if (category && ![...$('categories').children].some(o => o.value === category)) { const option = document.createElement('option'); option.value = category; $('categories').append(option); }
  } catch (error) { message(error.message, true); }
}
function newPost() {
  applyDraft({ path: `${PREFIX}post-${Date.now()}.md`, metadata: { published: today(), author: 'John River', comment: true }, body: '', images: [] });
  dirty = false; $('draft-status').textContent = '草稿保存在当前浏览器'; message('');
}
async function enter() {
  $('login-panel').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
  if (!ready) { await loadEditor(); newPost();
    try { const draft = await draftStore('get'); if (draft) { applyDraft(draft); dirty = true; $('draft-status').textContent = '已恢复本机草稿（包括待发布图片）'; } } catch { message('当前浏览器无法自动保存草稿，请使用“导出草稿”。', true); }
  }
  await refresh();
}
async function encodeFile(file) {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024 || !file.size) throw new Error('请选择不超过 5 MB 的 PNG、JPEG、WebP 或 GIF 图片。');
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
}
async function addImages(files, cover = false) {
  const newImages = [];
  for (const file of files) {
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[file.type];
    const content = await encodeFile(file);
    newImages.push({ path: `public/uploads/${crypto.randomUUID()}.${extension}`, content });
  }
  const combined = [...images, ...newImages];
  if (combined.length > 20 || combined.reduce((n, i) => n + i.content.length * .75, 0) > 10 * 1024 * 1024) throw new Error('一次最多支持 20 张新图片，总大小不超过 10 MB。');
  images = combined;
  for (const image of newImages) {
    if (cover) $('image').value = publicPath(image);
    else {
      const value = `\n![图片](${uri(image)})\n`;
      if (editor) editor.insertValue(value); else { $('markdown').value += value; preview(); }
    }
  }
  queueSave();
}
async function publish() {
  if (!$('article-form').reportValidity()) return;
  const payload = collect();
  if (!payload.body.trim()) { message('请先写下正文。', true); return; }
  payload.images = images.filter(image => payload.body.includes(publicPath(image)) || payload.metadata.image === publicPath(image));
  if (!confirm(`确认${sha ? '更新' : '发布'}《${payload.metadata.title}》？\n文章及使用的图片将提交到公开仓库，并触发网站部署。`)) return;
  await saveDraft(); $('workspace').inert = true; message('正在保存文章和图片，请保持页面打开…');
  try {
    const result = await api('publish', payload);
    // The commit is durable. Reload the new file SHA before allowing another update.
    activePath = result.path; const saved = await api(`post?path=${encodeURIComponent(result.path)}`).catch(() => null);
    sha = saved?.sha || ''; if (saved) images = [];
    if (saved) setBody(payload.body);
    $('slug').disabled = true; $('publish').disabled = !saved;
    $('publish').textContent = '发布更新'; dirty = false; clearTimeout(timer); await saveDraft();
    $('commit-link').href = result.commitUrl; $('article-link').href = result.url; $('publish-result').hidden = false;
    message(saved ? '已保存到 GitHub。网站上线需要等待 Cloudflare 构建，文章链接可能暂时返回 404。' : '文章已提交成功，但未能读取最新版本。请刷新文章列表并重新打开文章，再继续编辑。');
    await refresh();
  } catch (error) { message(`${error.message}\n本机草稿已保留。`, true); }
  finally { $('workspace').inert = false; }
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; message('正在登录…', false, true);
  try { await api('login', { password: $('password').value }); $('password').value = ''; await enter(); }
  catch (error) { message(error.message, true, true); } finally { button.disabled = false; }
});
$('logout').addEventListener('click', async () => {
  await saveDraft(); try { await api('logout', {}); location.reload(); } catch (error) { message(error.message, true); }
});
$('article-form').addEventListener('input', queueSave);
$('article-form').addEventListener('submit', event => event.preventDefault());
$('markdown').addEventListener('input', () => { preview(); queueSave(); });
$('post-search').addEventListener('input', renderList); $('refresh').addEventListener('click', refresh);
$('new-post').addEventListener('click', async () => { if (dirty && !confirm('新建文章会替换当前本机草稿，是否继续？')) return; clearTimeout(timer); await saving; newPost(); await draftStore('delete'); });
$('clear-draft').addEventListener('click', async () => { if (!confirm('清除当前草稿及待上传图片？已发布的文章不会受到影响。')) return; clearTimeout(timer); await saving; newPost(); await draftStore('delete'); });
$('publish').addEventListener('click', publish);
$('insert-image').addEventListener('click', () => $('image-files').click()); $('cover-upload').addEventListener('click', () => $('cover-file').click());
for (const [id, cover] of [['image-files', false], ['cover-file', true]]) $(id).addEventListener('change', async event => {
  try { await addImages(event.target.files, cover); } catch (error) { message(error.message, true); } finally { event.target.value = ''; }
});
$('export-draft').addEventListener('click', () => {
  const data = collect(); let body = data.body; for (const image of images) body = body.split(publicPath(image)).join(uri(image));
  const front = Object.entries(data.metadata).map(([k, v]) => `${k}: ${k === 'published' ? v : JSON.stringify(v)}`).join('\n');
  const url = URL.createObjectURL(new Blob([`---\n${front}\n---\n\n${body}`], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${$('slug').value.replaceAll('/', '-') || 'draft'}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
api('session').then(enter).catch(error => { if (!error.message.includes('请先登录')) message(error.message, true, true); });
