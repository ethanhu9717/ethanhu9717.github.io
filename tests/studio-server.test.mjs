import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudioServer } from '../scripts/beacon/studio-server.mjs';
import { atomicWrite, Workspace } from '../scripts/beacon/storage.mjs';
import { updateMetadata } from '../scripts/beacon/document.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'beacon-studio-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const studio = await createStudioServer({ root });
  await studio.start();
  t.after(() => studio.stop());
  return { root, studio };
}

async function request(studio, pathname, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('X-Beacon-Token', studio.sessionToken);
  if (['POST', 'PUT'].includes(options.method)) headers.set('Origin', studio.url);
  const response = await fetch(`${studio.url}${pathname}`, { ...options, headers });
  return { response, body: await response.json() };
}

async function requestWithRawHeaders(studio, pathname, headers) {
  const target = new URL(studio.url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: target.hostname, port: target.port, path: pathname, headers },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function json(method, body, headers = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

test('creates, saves, filters, and reads a Chinese article after a server restart', async (t) => {
  const { root, studio } = await fixture(t);
  const health = await request(studio, '/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);

  const created = await request(
    studio,
    '/api/articles',
    json(
      'POST',
      { title: '中文写作', body: '第一段\n\n第二段', summary: '简短摘要', slug: 'zhongwen' },
      { 'Idempotency-Key': 'create-chinese-1' },
    ),
  );
  assert.equal(created.response.status, 201);
  const first = created.body.article;
  assert.match(first.id, /\.md$/);
  assert.equal(first.title, '中文写作');
  assert.equal(first.body, '第一段\n\n第二段');
  assert.equal(first.summary, '简短摘要');
  assert.match(first.revision, /^[a-f0-9]{64}$/);

  const listed = await request(studio, '/api/articles?search=%E4%B8%AD%E6%96%87&status=draft&limit=1&offset=0');
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.total, 1);
  assert.equal(listed.body.items[0].id, first.id);

  const saved = await request(
    studio,
    `/api/articles/${encodeURIComponent(first.id)}`,
    json('PUT', {
      baseRevision: first.revision,
      title: '中文写作（已保存）',
      body: '写入磁盘的正文',
      summary: '更新摘要',
      slug: 'zhongwen-v2',
    }),
  );
  assert.equal(saved.response.status, 200);
  const second = saved.body.article;
  assert.notEqual(second.revision, first.revision);
  assert.equal(second.body, '写入磁盘的正文');
  const markdown = await readFile(path.join(root, 'src/content/drafts', first.id), 'utf8');
  assert.match(markdown, /中文写作（已保存）/);
  assert.match(markdown, /写入磁盘的正文/);

  await studio.stop();
  const restarted = await createStudioServer({ root });
  await restarted.start();
  t.after(() => restarted.stop());
  const restored = await request(restarted, `/api/articles/${encodeURIComponent(first.id)}`);
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.article.body, '写入磁盘的正文');
  assert.equal(restored.body.article.revision, second.revision);
});

test('Idempotency-Key prevents duplicate creates and does not accept a different request', async (t) => {
  const { studio } = await fixture(t);
  const options = json('POST', { title: '只创建一次', body: '内容' }, { 'Idempotency-Key': 'same-intent' });
  const first = await request(studio, '/api/articles', options);
  const second = await request(studio, '/api/articles', options);
  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);
  assert.equal(second.body.article.id, first.body.article.id);
  const list = await request(studio, '/api/articles');
  assert.equal(list.body.total, 1);

  const reused = await request(
    studio,
    '/api/articles',
    json('POST', { title: '另一篇' }, { 'Idempotency-Key': 'same-intent' }),
  );
  assert.equal(reused.response.status, 409);
  assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('stale revisions return the disk version and preserve submitted client text', async (t) => {
  const { studio } = await fixture(t);
  const created = await request(
    studio,
    '/api/articles',
    json('POST', { title: '冲突', body: '初始文本' }, { 'Idempotency-Key': 'conflict-create' }),
  );
  const article = created.body.article;
  const current = await request(
    studio,
    `/api/articles/${encodeURIComponent(article.id)}`,
    json('PUT', {
      baseRevision: article.revision,
      title: '冲突',
      body: '磁盘新版本',
      summary: '',
      slug: '',
    }),
  );
  assert.equal(current.response.status, 200);

  const stale = await request(
    studio,
    `/api/articles/${encodeURIComponent(article.id)}`,
    json('PUT', {
      baseRevision: article.revision,
      title: '冲突',
      body: '客户端仍要保留的文本',
      summary: '未保存摘要',
      slug: 'client-copy',
    }),
  );
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'CONFLICT');
  assert.equal(stale.body.article.body, '磁盘新版本');
  assert.equal(stale.body.revision, current.body.article.revision);
  assert.equal(stale.body.client.body, '客户端仍要保留的文本');
  assert.equal(stale.body.client.summary, '未保存摘要');
});

test('concurrent saves from the same durable revision produce one save and one conflict', async (t) => {
  const { studio } = await fixture(t);
  const created = await request(
    studio,
    '/api/articles',
    json('POST', { title: '并发', body: '初始' }, { 'Idempotency-Key': 'concurrent-create' }),
  );
  const article = created.body.article;
  const save = (body) =>
    request(
      studio,
      `/api/articles/${encodeURIComponent(article.id)}`,
      json('PUT', { baseRevision: article.revision, title: '并发', body, summary: '', slug: '' }),
    );
  const results = await Promise.all([save('第一个版本'), save('第二个版本')]);
  assert.deepEqual(
    results.map((result) => result.response.status).sort(),
    [200, 409],
  );
  const conflict = results.find((result) => result.response.status === 409).body;
  assert.equal(conflict.error.code, 'CONFLICT');
  assert.match(conflict.article.body, /^第[一二]个版本$/);
});

test('a failed write reports failure without replacing the durable article', async (t) => {
  const { studio } = await fixture(t);
  const created = await request(
    studio,
    '/api/articles',
    json('POST', { title: '写入失败', body: '已保存版本' }, { 'Idempotency-Key': 'failure-create' }),
  );
  const article = created.body.article;
  const write = studio.workspace.write;
  studio.workspace.write = async (file, value) => {
    if (file.endsWith('.md')) throw new Error('模拟磁盘失败');
    return write(file, value);
  };
  const failed = await request(
    studio,
    `/api/articles/${encodeURIComponent(article.id)}`,
    json('PUT', {
      baseRevision: article.revision,
      title: '写入失败',
      body: '不应覆盖磁盘',
      summary: '',
      slug: '',
    }),
  );
  assert.equal(failed.response.status, 500);
  assert.equal(failed.body.error.code, 'LOCAL_WRITE_FAILED');
  studio.workspace.write = write;
  const restored = await request(studio, `/api/articles/${encodeURIComponent(article.id)}`);
  assert.equal(restored.body.article.body, '已保存版本');
  assert.equal(restored.body.article.revision, article.revision);
});

test('supports published filtering and rejects encoded path traversal', async (t) => {
  const { root, studio } = await fixture(t);
  const raw = updateMetadata('公开正文', {
    title: '公开文章',
    date: '2026-09-21',
    category: 'Daily',
    tags: [],
    description: '',
    draft: false,
  });
  await atomicWrite(path.join(root, 'src/content/posts/published.md'), raw);
  const published = await request(studio, '/api/articles?status=published');
  assert.equal(published.response.status, 200);
  assert.equal(published.body.total, 1);
  assert.equal(published.body.items[0].id, 'published.md');
  const escaped = await request(studio, '/api/articles/%2E%2E%2Foutside.md');
  assert.equal(escaped.response.status, 400);
  assert.equal(escaped.body.error.code, 'INVALID_ARTICLE_ID');
});

test('refuses a content directory symlink that leaves the chosen workspace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'beacon-studio-link-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'beacon-studio-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await mkdir(path.join(root, 'src', 'content'), { recursive: true });
  await writeFile(path.join(outside, 'unrelated.md'), 'outside');
  await symlink(outside, path.join(root, 'src', 'content', 'drafts'));
  await assert.rejects(createStudioServer({ root }), /工作区内容路径不安全/);
});

test('an equal private work copy does not make a published article look newly written', async (t) => {
  const { root, studio } = await fixture(t);
  const file = path.join(root, 'src/content/posts/opened.md');
  await atomicWrite(
    file,
    updateMetadata('公开正文', {
      title: '只打开',
      date: '2026-09-21',
      category: 'Daily',
      tags: [],
      description: '',
      draft: false,
    }),
  );
  const past = new Date('2026-09-20T00:00:00.000Z');
  await utimes(file, past, past);
  const workspace = new Workspace(root);
  await workspace.openArticle(await workspace.get('opened.md'));
  assert.notEqual((await stat(file)).mtimeMs, (await stat(path.join(root, '.beacon/work/opened.md'))).mtimeMs);

  const listed = await request(studio, '/api/articles?status=published');
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.items[0].updatedAt, past.toISOString());
});

test('optionally serves only the fixed Studio assets and article routes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'beacon-studio-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const studio = await createStudioServer({
    root,
    staticDir: path.join(sourceRoot, 'scripts/beacon/studio'),
  });
  await studio.start();
  t.after(() => studio.stop());

  const index = await fetch(`${studio.url}/articles/example.md`);
  assert.equal(index.status, 200);
  const page = await index.text();
  assert.match(page, /Beacon Studio/);
  assert.doesNotMatch(page, /__BEACON_STUDIO_TOKEN__/);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);

  const asset = await fetch(`${studio.url}/studio/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /text\/javascript/);

  const unexpected = await fetch(`${studio.url}/studio/../../storage.mjs`);
  assert.equal(unexpected.status, 404);
});

test('requires the local session token and same-origin marker for API writes', async (t) => {
  const { studio } = await fixture(t);
  const missingToken = await fetch(`${studio.url}/api/articles`);
  assert.equal(missingToken.status, 403);
  assert.equal((await missingToken.json()).error.code, 'SESSION_REQUIRED');

  const missingOrigin = await fetch(`${studio.url}/api/articles`,
    json('POST', {}, { 'X-Beacon-Token': studio.sessionToken }),
  );
  assert.equal(missingOrigin.status, 403);
  assert.equal((await missingOrigin.json()).error.code, 'ORIGIN_REQUIRED');

  const wrongOrigin = await fetch(`${studio.url}/api/articles`,
    json('POST', {}, { 'X-Beacon-Token': studio.sessionToken, Origin: 'http://evil.example' }),
  );
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await wrongOrigin.json()).error.code, 'INVALID_ORIGIN');

  const wrongHost = await requestWithRawHeaders(studio, '/api/health', {
    'X-Beacon-Token': studio.sessionToken,
    Host: 'evil.example',
  });
  assert.equal(wrongHost.status, 403);
  assert.equal(wrongHost.body.error.code, 'INVALID_HOST');
});
