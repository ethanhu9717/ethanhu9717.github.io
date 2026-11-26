import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, realpath, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ConflictError, Workspace, digest } from './storage.mjs';
import { metadata, replaceBody, splitDocument, updateMetadata } from './document.mjs';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ARTICLE_BODY = 1024 * 1024;
const MAX_IDEMPOTENCY_KEYS = 256;
const ARTICLE_ID = /^[\p{L}\p{N}][\p{L}\p{N}._-]*\.mdx?$/u;
const LAYOUT_DIRECTORIES = [
  'src',
  'src/content',
  'src/content/drafts',
  'src/content/posts',
  '.beacon',
  '.beacon/work',
  '.beacon/recovery',
];

class StudioHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new StudioHttpError(status, code, message);
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function assertInside(root, candidate) {
  if (!isInside(root, candidate)) fail(403, 'WORKSPACE_PATH_UNSAFE', '工作区内容路径不安全');
}

function isSafeArticleId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 200 &&
    Buffer.byteLength(id, 'utf8') <= 240 &&
    !id.includes('..') &&
    ARTICLE_ID.test(id)
  );
}

function decodeArticleId(encoded) {
  if (!encoded || encoded.includes('/')) fail(400, 'INVALID_ARTICLE_ID', '文章标识无效');
  let id;
  try {
    id = decodeURIComponent(encoded);
  } catch {
    fail(400, 'INVALID_ARTICLE_ID', '文章标识编码无效');
  }
  if (!isSafeArticleId(id)) fail(400, 'INVALID_ARTICLE_ID', '文章标识无效');
  return id;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

async function sendStatic(response, request, resource, sessionToken) {
  let body = request.method === 'HEAD' ? null : await readFile(resource.file);
  if (body && resource.tokenized) {
    const source = body.toString('utf8');
    if (!source.includes('__BEACON_STUDIO_TOKEN__')) throw new Error('Studio 页面缺少会话标记');
    body = Buffer.from(source.replaceAll('__BEACON_STUDIO_TOKEN__', sessionToken), 'utf8');
  }
  const headers = {
    'cache-control': 'no-store',
    'content-type': resource.contentType,
    'content-security-policy':
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
  response.writeHead(200, headers);
  response.end(body);
}

function publicError(error) {
  if (error instanceof StudioHttpError)
    return { status: error.status, code: error.code, message: error.message };
  if (error?.code === 'ENOENT') return { status: 404, code: 'NOT_FOUND', message: '文章不存在' };
  if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EROFS')
    return { status: 500, code: 'LOCAL_WRITE_FAILED', message: '本地文件无法写入' };
  return { status: 500, code: 'INTERNAL_ERROR', message: '本地服务发生错误' };
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      oversized = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (oversized) fail(413, 'REQUEST_TOO_LARGE', '请求内容过大');
  if (size === 0) fail(400, 'JSON_REQUIRED', '需要 JSON 请求内容');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail(400, 'INVALID_JSON', 'JSON 格式无效');
  }
}

function assertObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(400, 'INVALID_ARTICLE', '文章内容必须是对象');
}

function validateText(value, name, maximum, { singleLine = false, slug = false } = {}) {
  if (typeof value !== 'string') fail(400, 'INVALID_ARTICLE', `${name} 必须是文本`);
  if (value.length > maximum) fail(413, 'ARTICLE_TOO_LARGE', `${name} 过长`);
  if (/\0|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    fail(400, 'INVALID_ARTICLE', `${name} 含有不支持的控制字符`);
  if (singleLine && /[\r\n]/.test(value)) fail(400, 'INVALID_ARTICLE', `${name} 不能换行`);
  if (slug && (value.includes('/') || value.includes('\\') || value === '.' || value === '..'))
    fail(400, 'INVALID_ARTICLE', '固定链接不能包含路径');
  return value;
}

function validateFields(value, { update = false } = {}) {
  assertObject(value);
  const allowed = new Set(update ? ['baseRevision', 'title', 'body', 'summary', 'slug'] : ['title', 'body', 'summary', 'slug']);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) fail(400, 'UNSUPPORTED_FIELD', `不支持字段：${key}`);

  const fields = {};
  if (Object.hasOwn(value, 'title')) fields.title = validateText(value.title, '标题', 500, { singleLine: true });
  if (Object.hasOwn(value, 'body')) fields.body = validateText(value.body, '正文', MAX_ARTICLE_BODY);
  if (Object.hasOwn(value, 'summary'))
    fields.summary = validateText(value.summary, '摘要', 4000, { singleLine: false });
  if (Object.hasOwn(value, 'slug')) fields.slug = validateText(value.slug, '固定链接', 200, { singleLine: true, slug: true });

  if (!update) return fields;
  if (typeof value.baseRevision !== 'string' || !/^[a-f0-9]{64}$/.test(value.baseRevision))
    fail(400, 'INVALID_REVISION', 'baseRevision 无效');
  return { baseRevision: value.baseRevision, fields };
}

function articleFingerprint(fields) {
  const sorted = Object.keys(fields)
    .sort()
    .map((key) => [key, fields[key]]);
  return digest(JSON.stringify(sorted));
}

function idempotencyKey(request) {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key) || key.includes(','))
    fail(400, 'IDEMPOTENCY_KEY_REQUIRED', '需要有效的 Idempotency-Key');
  return key;
}

function applyFields(raw, fields) {
  let next = raw;
  const changes = {};
  if (Object.hasOwn(fields, 'title')) changes.title = fields.title;
  if (Object.hasOwn(fields, 'summary')) changes.description = fields.summary;
  if (Object.hasOwn(fields, 'slug')) changes.slug = fields.slug;
  if (Object.keys(changes).length) next = updateMetadata(next, changes);
  if (Object.hasOwn(fields, 'body')) next = replaceBody(next, fields.body);
  return next;
}

function applyFieldsSafely(raw, fields) {
  try {
    return applyFields(raw, fields);
  } catch {
    fail(422, 'ARTICLE_FORMAT_INVALID', '文章信息格式错误，请先修正后再保存');
  }
}

function metadataText(data, key) {
  return typeof data[key] === 'string' ? data[key] : '';
}

function isoTime(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function oneQueryValue(query, name) {
  const values = query.getAll(name);
  if (values.length > 1) fail(400, 'INVALID_QUERY', `${name} 只能提供一次`);
  return values[0];
}

function queryInteger(query, name, fallback, maximum, { minimum = 0 } = {}) {
  const value = oneQueryValue(query, name);
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) fail(400, 'INVALID_QUERY', `${name} 无效`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    fail(400, 'INVALID_QUERY', `${name} 超出范围`);
  return parsed;
}

function queryOptions(query) {
  const search = oneQueryValue(query, 'search') ?? '';
  validateText(search, 'search', 200, { singleLine: true });
  const givenStatus = oneQueryValue(query, 'status') ?? 'all';
  const statusMap = new Map([
    ['all', 'all'],
    ['draft', 'draft'],
    ['published', 'published'],
    ['草稿', 'draft'],
    ['已发布', 'published'],
  ]);
  const status = statusMap.get(givenStatus);
  if (!status) fail(400, 'INVALID_QUERY', 'status 无效');
  return {
    search,
    status,
    limit: queryInteger(query, 'limit', 50, 100, { minimum: 1 }),
    offset: queryInteger(query, 'offset', 0, 100000),
  };
}

/**
 * Build a loopback-only API adapter around Beacon's existing file workspace.
 * A launcher can optionally provide a fixed static asset directory. It is never
 * exposed through Astro and has no route to the private workspace files.
 */
export async function createStudioServer({ root, host = '127.0.0.1', port = 0, staticDir } = {}) {
  if (host !== '127.0.0.1') throw new Error('Beacon Studio 仅允许监听 127.0.0.1');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效');
  if (typeof root !== 'string' || !root) throw new Error('需要明确的工作区路径');

  const requestedRoot = path.resolve(root);
  await mkdir(requestedRoot, { recursive: true });
  const workspaceRoot = await realpath(requestedRoot);
  const rootStat = await stat(workspaceRoot);
  if (!rootStat.isDirectory()) throw new Error('工作区路径不是目录');
  const workspace = new Workspace(workspaceRoot);
  const sessionToken = randomBytes(32).toString('base64url');
  let staticFiles = null;
  if (staticDir !== undefined) {
    if (typeof staticDir !== 'string' || !staticDir) throw new Error('Studio 静态资源目录无效');
    const staticRoot = await realpath(staticDir);
    if (!(await stat(staticRoot)).isDirectory()) throw new Error('Studio 静态资源目录不是文件夹');
    const resources = [
      ['index', 'index.html', 'text/html; charset=utf-8'],
      ['style', 'style.css', 'text/css; charset=utf-8'],
      ['app', 'app.js', 'text/javascript; charset=utf-8'],
    ];
    staticFiles = new Map(
      await Promise.all(
        resources.map(async ([name, relative, contentType]) => {
          const file = await realpath(path.join(staticRoot, relative));
          if (!isInside(staticRoot, file) || !(await stat(file)).isFile())
            throw new Error('Studio 静态资源路径不安全');
          return [name, { file, contentType, tokenized: name === 'index' }];
        }),
      ),
    );
  }

  async function assertDirectorySafe(directory, { optional = false } = {}) {
    let resolved;
    try {
      resolved = await realpath(directory);
    } catch (error) {
      if (optional && error?.code === 'ENOENT') return false;
      throw error;
    }
    assertInside(workspaceRoot, resolved);
    if (!(await stat(resolved)).isDirectory())
      fail(403, 'WORKSPACE_PATH_UNSAFE', '工作区目录不安全');
    return true;
  }

  async function assertFileSafe(file, { optional = false } = {}) {
    let resolved;
    try {
      resolved = await realpath(file);
    } catch (error) {
      if (optional && error?.code === 'ENOENT') return false;
      throw error;
    }
    assertInside(workspaceRoot, resolved);
    if (!(await stat(resolved)).isFile()) fail(403, 'WORKSPACE_PATH_UNSAFE', '文章文件不安全');
    return true;
  }

  async function assertWorkspaceSafe() {
    for (const relative of LAYOUT_DIRECTORIES)
      await assertDirectorySafe(path.join(workspaceRoot, relative), { optional: true });
  }

  // Validate pre-existing paths before Workspace.initialize() makes any directories,
  // then verify them again because Workspace.resolve() itself is lexical only.
  await assertWorkspaceSafe();
  await workspace.initialize();
  await assertWorkspaceSafe();

  async function preflightWorkspaceRecords() {
    for (const type of ['drafts', 'posts']) {
      const directory = path.join(workspaceRoot, 'src', 'content', type);
      const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error?.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries) {
        if (
          !entry.isFile() ||
          !/\.mdx?$/.test(entry.name) ||
          entry.name.startsWith('.') ||
          /\.agent-backup-/.test(entry.name)
        )
          continue;
        await assertFileSafe(path.join(directory, entry.name));
        if (type === 'posts')
          await assertFileSafe(path.join(workspaceRoot, '.beacon', 'work', entry.name), {
            optional: true,
          });
      }
    }
  }

  async function articlePaths(row) {
    if (!isSafeArticleId(row.id)) fail(404, 'NOT_FOUND', '文章不存在');
    const source = workspace.resolve(row.publicPath);
    const work = workspace.resolve(row.workingPath);
    if (row.published) {
      await assertFileSafe(source);
      await assertFileSafe(work, { optional: true });
    } else await assertFileSafe(work);
    return { source, work };
  }

  async function listRows() {
    await assertWorkspaceSafe();
    await preflightWorkspaceRecords();
    const rows = await workspace.list();
    const safeRows = [];
    for (const row of rows) {
      if (!isSafeArticleId(row.id)) continue;
      const paths = await articlePaths(row);
      if (row.published && row.status === '本地发布稿')
        row.modified = (await stat(paths.source)).mtimeMs;
      safeRows.push(row);
    }
    return safeRows;
  }

  async function findRow(id) {
    const row = (await listRows()).find((candidate) => candidate.id === id);
    if (!row) fail(404, 'NOT_FOUND', '文章不存在');
    return row;
  }

  async function readCurrent(row) {
    const { source, work } = await articlePaths(row);
    if (row.published && (await assertFileSafe(work, { optional: true })))
      return { raw: await readFile(work, 'utf8'), file: work };
    const file = row.published ? source : work;
    return { raw: await readFile(file, 'utf8'), file };
  }

  async function serialize(row, raw) {
    const current = await readCurrent(row);
    const workInfo = await stat(current.file);
    let createdInfo = workInfo;
    let updatedInfo = workInfo;
    if (row.published) {
      const { source } = await articlePaths(row);
      const sourceRaw = await readFile(source, 'utf8');
      const sourceInfo = await stat(source);
      createdInfo = sourceInfo;
      // Opening a public post in the terminal creates an identical private work
      // copy. That access must not make the post appear newly written in Studio.
      if (raw === sourceRaw) updatedInfo = sourceInfo;
    }
    const data = metadata(raw);
    return {
      id: row.id,
      title: metadataText(data, 'title'),
      body: splitDocument(raw).body,
      summary: metadataText(data, 'description'),
      slug: metadataText(data, 'slug'),
      status: row.status,
      published: row.published,
      createdAt: isoTime(createdInfo.birthtimeMs || createdInfo.ctimeMs),
      updatedAt: isoTime(updatedInfo.mtimeMs),
      revision: digest(raw),
    };
  }

  async function serializeCurrent(row) {
    const { raw } = await readCurrent(row);
    return serialize(row, raw);
  }

  async function conflictPayload(id, row, disk, client) {
    let latest = row;
    try {
      latest = await findRow(id);
    } catch (error) {
      if (!(error instanceof StudioHttpError) || error.status !== 404) throw error;
    }
    return {
      error: { code: 'CONFLICT', message: '文件已被其他编辑器修改' },
      article: disk === null ? null : await serialize(latest, disk),
      revision: disk === null ? null : digest(disk),
      // The server never writes this field during a conflict. It lets a client
      // retain every value it attempted to save while it presents the disk copy.
      client,
    };
  }

  async function createArticle(fields) {
    await assertWorkspaceSafe();
    await preflightWorkspaceRecords();
    const created = await workspace.create();
    const row = await findRow(created.id);
    const current = await readCurrent(row);
    const next = applyFieldsSafely(current.raw, fields);
    if (next !== current.raw) {
      try {
        const session = await workspace.openArticle(row);
        if (session.saved !== current.raw) throw new ConflictError(session.saved);
        await workspace.save(session, next);
      } catch (error) {
        if (error instanceof StudioHttpError) throw error;
        fail(500, 'LOCAL_WRITE_FAILED', '本地文件无法写入');
      }
    }
    return serializeCurrent(await findRow(created.id));
  }

  const articleQueues = new Map();

  function queueArticle(id, operation) {
    const previous = articleQueues.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    articleQueues.set(id, task);
    task
      .finally(() => {
        if (articleQueues.get(id) === task) articleQueues.delete(id);
      })
      .catch(() => {});
    return task;
  }

  function updateArticle(id, update) {
    // Workspace.save serializes writes, but opening a session also briefly takes
    // its lock. Queue the complete read/compare/open/save transaction so two
    // browser requests with the same baseRevision deterministically yield one
    // success and one 409 instead of a transient lock error.
    return queueArticle(id, async () => {
      const row = await findRow(id);
      const current = await readCurrent(row);
      if (digest(current.raw) !== update.baseRevision)
        return {
          conflict: true,
          payload: await conflictPayload(id, row, current.raw, {
            baseRevision: update.baseRevision,
            ...update.fields,
          }),
        };

      const next = applyFieldsSafely(current.raw, update.fields);
      if (next === current.raw) return { conflict: false, article: await serialize(row, current.raw) };

      try {
        // openArticle creates a private working copy for a published post only after
        // its public version has matched the caller's durable baseRevision.
        const session = await workspace.openArticle(row);
        if (digest(session.saved) !== update.baseRevision)
          return {
            conflict: true,
            payload: await conflictPayload(id, row, session.saved, {
              baseRevision: update.baseRevision,
              ...update.fields,
            }),
          };
        await workspace.save(session, next);
      } catch (error) {
        if (error instanceof ConflictError)
          return {
            conflict: true,
            payload: await conflictPayload(id, row, error.disk, {
              baseRevision: update.baseRevision,
              ...update.fields,
            }),
          };
        if (error instanceof StudioHttpError) throw error;
        if (String(error?.message).includes('另一个 Beacon'))
          fail(503, 'ARTICLE_BUSY', '文章正在保存，请重试');
        fail(500, 'LOCAL_WRITE_FAILED', '本地文件无法写入');
      }
      return { conflict: false, article: await serializeCurrent(await findRow(id)) };
    });
  }

  const idempotency = new Map();
  let boundPort = null;

  function assertRequestOrigin(request) {
    const remote = request.socket.remoteAddress;
    if (remote && remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1')
      fail(403, 'LOOPBACK_ONLY', '本地服务只接受本机请求');
    const hostHeader = request.headers.host;
    const expectedHosts = new Set([
      `127.0.0.1:${boundPort}`,
      ...(boundPort === 80 ? ['127.0.0.1'] : []),
    ]);
    if (typeof hostHeader !== 'string' || !expectedHosts.has(hostHeader))
      fail(403, 'INVALID_HOST', '请求主机无效');
    const origin = request.headers.origin;
    if (!origin) return;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      fail(403, 'INVALID_ORIGIN', '请求来源无效');
    }
    if (parsed.origin !== new URL(`http://127.0.0.1:${boundPort}`).origin)
      fail(403, 'INVALID_ORIGIN', '请求来源无效');
  }

  function assertSession(request) {
    const received = request.headers['x-beacon-token'];
    const expectedBytes = Buffer.from(sessionToken, 'utf8');
    const receivedBytes = typeof received === 'string' ? Buffer.from(received, 'utf8') : null;
    if (
      !receivedBytes ||
      receivedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(receivedBytes, expectedBytes)
    )
      fail(403, 'SESSION_REQUIRED', 'Beacon Studio 会话无效，请刷新页面');
  }

  function assertStateChangeRequest(request) {
    if (!['POST', 'PUT'].includes(request.method || '')) return;
    if (typeof request.headers.origin !== 'string')
      fail(403, 'ORIGIN_REQUIRED', '写入请求缺少同源标记');
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json'))
      fail(415, 'JSON_CONTENT_TYPE_REQUIRED', '写入请求必须使用 JSON');
  }

  async function handle(request, response) {
    try {
      assertRequestOrigin(request);
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (staticFiles && (request.method === 'GET' || request.method === 'HEAD')) {
        const asset =
          url.pathname === '/studio/style.css'
            ? staticFiles.get('style')
            : url.pathname === '/studio/app.js'
              ? staticFiles.get('app')
              : url.pathname === '/' ||
                  url.pathname === '/studio' ||
                  url.pathname === '/studio/' ||
                  url.pathname === '/articles' ||
                  /^\/articles\/[^/]+$/.test(url.pathname)
                ? staticFiles.get('index')
                : null;
        if (asset) return await sendStatic(response, request, asset, sessionToken);
      }
      if (url.pathname.startsWith('/api/')) {
        assertSession(request);
        assertStateChangeRequest(request);
      }
      if (request.method === 'GET' && url.pathname === '/api/health') {
        await assertWorkspaceSafe();
        return sendJson(response, 200, {
          ok: true,
          listener: '127.0.0.1',
          workspace: workspaceRoot,
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/articles') {
        const options = queryOptions(url.searchParams);
        const rows = (await listRows())
          .filter((row) => options.status === 'all' || (options.status === 'published') === row.published)
          .sort((left, right) => right.modified - left.modified || left.id.localeCompare(right.id));
        const lowerSearch = options.search.toLocaleLowerCase();
        const matched = lowerSearch
          ? rows.filter((row) => row.title.toLocaleLowerCase().includes(lowerSearch))
          : rows;
        const page = matched.slice(options.offset, options.offset + options.limit);
        return sendJson(response, 200, {
          items: await Promise.all(page.map((row) => serializeCurrent(row))),
          total: matched.length,
          limit: options.limit,
          offset: options.offset,
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/articles') {
        const fields = validateFields(await readJson(request));
        const key = idempotencyKey(request);
        const fingerprint = articleFingerprint(fields);
        let entry = idempotency.get(key);
        if (entry && entry.fingerprint !== fingerprint)
          fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key 已用于不同的新建请求');
        if (!entry) {
          const promise = createArticle(fields);
          entry = { fingerprint, promise };
          idempotency.set(key, entry);
          if (idempotency.size > MAX_IDEMPOTENCY_KEYS) idempotency.delete(idempotency.keys().next().value);
          promise.catch(() => {
            if (idempotency.get(key) === entry) idempotency.delete(key);
          });
        }
        return sendJson(response, 201, { article: await entry.promise });
      }
      if ((request.method === 'GET' || request.method === 'PUT') && url.pathname.startsWith('/api/articles/')) {
        const id = decodeArticleId(url.pathname.slice('/api/articles/'.length));
        if (request.method === 'GET') return sendJson(response, 200, { article: await serializeCurrent(await findRow(id)) });
        const result = await updateArticle(id, validateFields(await readJson(request), { update: true }));
        if (result.conflict) return sendJson(response, 409, result.payload);
        return sendJson(response, 200, { article: result.article });
      }
      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
    } catch (error) {
      const exposed = publicError(error);
      sendJson(response, exposed.status, { error: { code: exposed.code, message: exposed.message } });
    }
  }

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  const api = {
    workspace,
    server,
    host,
    get sessionToken() {
      return sessionToken;
    },
    get port() {
      return boundPort;
    },
    get url() {
      return boundPort === null ? null : `http://127.0.0.1:${boundPort}`;
    },
    async start() {
      if (server.listening) return { host, port: boundPort, url: api.url };
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          boundPort = typeof address === 'object' && address ? address.port : port;
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host, port });
      });
      return { host, port: boundPort, url: api.url };
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      boundPort = null;
    },
  };
  return api;
}

export async function startStudioServer(options) {
  const studio = await createStudioServer(options);
  await studio.start();
  return studio;
}
