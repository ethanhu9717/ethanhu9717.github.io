import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Workspace, atomicWrite, ConflictError } from '../scripts/beacon/storage.mjs';
import { Publisher, run } from '../scripts/beacon/publisher.mjs';
import { Buffer, width } from '../scripts/beacon/buffer.mjs';
import { InputDecoder } from '../scripts/beacon/input.mjs';
import {
  metadata,
  splitDocument,
  updateMetadata,
  previewLines,
} from '../scripts/beacon/document.mjs';
const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
async function fixture(t, options) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'beacon-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new Workspace(root, options);
  await workspace.initialize();
  return workspace;
}
const post = (title, body = '正文') =>
  updateMetadata(body, {
    title,
    date: '2026-09-20',
    category: 'Daily',
    tags: [],
    description: '摘要',
    draft: false,
  });

test('same-day articles have independent stable identities and readable titles', async (t) => {
  const workspace = await fixture(t);
  const a = await workspace.create('20260920');
  const b = await workspace.create('20260920');
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^20260920-/);
  const session = await workspace.openArticle(a);
  await workspace.save(session, post('中文标题'));
  assert.equal((await workspace.get(a.id)).title, '中文标题');
});
test('editing a public article creates only a private work copy', async (t) => {
  const workspace = await fixture(t);
  const original = post('A');
  await atomicWrite(workspace.resolve('src/content/posts/old-url.mdx'), original);
  const session = await workspace.openArticle(await workspace.get('old-url.mdx'));
  await workspace.save(session, post('A', '私有修改'));
  assert.equal(
    await readFile(workspace.resolve('src/content/posts/old-url.mdx'), 'utf8'),
    original,
  );
  assert.equal((await workspace.get('old-url.mdx')).status, '有未发布修改');
});
test('delayed save remains bound to A while B opens and saves', async (t) => {
  let release;
  let blocked = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const workspace = await fixture(t, {
    write: async (file, text) => {
      if (blocked && file.endsWith('.md')) await gate;
      await atomicWrite(file, text);
    },
  });
  const a = await workspace.openArticle(await workspace.create());
  const b = await workspace.openArticle(await workspace.create());
  blocked = true;
  const saveA = workspace.save(a, post('A'));
  const saveB = workspace.save(b, post('B'));
  release();
  await Promise.all([saveA, saveB]);
  assert.equal(metadata(await readFile(a.file, 'utf8')).title, 'A');
  assert.equal(metadata(await readFile(b.file, 'utf8')).title, 'B');
  assert.equal(metadata(a.saved).title, 'A');
  assert.equal(metadata(b.saved).title, 'B');
});
test('queued saves preserve latest content and do not acknowledge subsequent edits', async (t) => {
  const workspace = await fixture(t);
  const session = await workspace.openArticle(await workspace.create());
  const one = workspace.save(session, '第一版');
  const two = workspace.save(session, '第二版');
  await Promise.all([one, two]);
  assert.equal(session.saved, '第二版');
  assert.equal(await readFile(session.file, 'utf8'), '第二版');
});
test('external changes raise conflict; confirmed overwrite checks observed version again', async (t) => {
  const workspace = await fixture(t);
  const session = await workspace.openArticle(await workspace.create());
  await atomicWrite(session.file, '外部版本');
  await assert.rejects(workspace.save(session, '当前版本'), ConflictError);
  await atomicWrite(session.file, '外部再次修改');
  await assert.rejects(
    workspace.save(session, '当前版本', { force: true, expectedDisk: '外部版本' }),
    ConflictError,
  );
  assert.equal(await readFile(session.file, 'utf8'), '外部再次修改');
  await workspace.save(session, '确认覆盖', { force: true, expectedDisk: '外部再次修改' });
  assert.equal(await readFile(session.file, 'utf8'), '确认覆盖');
});
test('failed primary write preserves old file and offers recovery on reopen', async (t) => {
  let fail = false;
  const workspace = await fixture(t, {
    write: async (file, value) => {
      if (fail && file.endsWith('.md')) throw new Error('模拟磁盘失败');
      await atomicWrite(file, value);
    },
  });
  const row = await workspace.create();
  const session = await workspace.openArticle(row);
  const before = session.saved;
  fail = true;
  await assert.rejects(workspace.save(session, '恢复内容'), /模拟磁盘失败/);
  assert.equal(await readFile(session.file, 'utf8'), before);
  const reopened = await new Workspace(workspace.root).openArticle(row);
  assert.equal(reopened.recovery.content, '恢复内容');
});
test('acknowledged atomic write survives a fresh workspace and leaves no temporary files', async (t) => {
  const workspace = await fixture(t);
  const row = await workspace.create();
  const session = await workspace.openArticle(row);
  await workspace.save(session, '保存确认');
  const reopened = await new Workspace(workspace.root).openArticle(row);
  assert.equal(reopened.saved, '保存确认');
  assert.equal(reopened.recovery, null);
  assert.equal(
    (await readdir(path.dirname(session.file))).some((name) => name.endsWith('.tmp')),
    false,
  );
});
test('metadata panel preserves unknown fields, YAML comments and exact body', () => {
  const raw = '---\n# 注释\ntitle: 旧标题\ncustom: [a, b]\n---\n\n正文 **内容**\n';
  const next = updateMetadata(raw, { title: '新标题', tags: ['中文', 'a,b'] });
  assert.match(next, /# 注释/);
  assert.deepEqual(metadata(next).custom, ['a', 'b']);
  assert.deepEqual(metadata(next).tags, ['中文', 'a,b']);
  assert.equal(splitDocument(next).body, splitDocument(raw).body);
  assert.throws(() => updateMetadata('---\ntitle: [\n---\n正文', { title: 'x' }), /格式错误/);
});
test('terminal preview uses current text and preserves image descriptions', () => {
  const raw = post('预览', '# 小标题\n\n![火箭](rocket.png)\n```js\nconst x = 1;\n```');
  const lines = previewLines(raw).join('\n');
  assert.match(lines, /预览/);
  assert.match(lines, /图片：火箭 · rocket.png/);
  assert.match(lines, /代码 js/);
  assert.doesNotMatch(lines, /draft: false/);
});
test('a 300-character paste is one undo transaction', () => {
  const buffer = new Buffer('');
  const text = '中'.repeat(300);
  buffer.insert(text);
  buffer.undo();
  assert.equal(buffer.text, '');
  buffer.redo();
  assert.equal(buffer.text, text);
});
test('grapheme deletion and movement preserve combined characters', () => {
  const buffer = new Buffer('中👨‍👩‍👧‍👦e\u0301文');
  buffer.cursor = buffer.text.length;
  buffer.left();
  buffer.backspace();
  assert.equal(buffer.text, '中👨‍👩‍👧‍👦文');
  buffer.backspace();
  assert.equal(buffer.text, '中文');
  assert.equal(width('中👨‍👩‍👧‍👦'), 4);
});
test('search after emoji advances and wraps in both directions', () => {
  const buffer = new Buffer('🙂词🙂词');
  buffer.cursor = 2;
  assert.equal(buffer.find('词'), true);
  assert.equal(buffer.cursor, 5);
  buffer.find('词');
  assert.equal(buffer.cursor, 2);
  buffer.find('词', -1);
  assert.equal(buffer.cursor, 5);
});
test('soft-wrap navigation follows visual rows', () => {
  const buffer = new Buffer('一二三四五六七八');
  buffer.cursor = 1;
  buffer.vertical(1, 6);
  assert.equal(buffer.cursor, 4);
  buffer.vertical(-1, 6);
  assert.equal(buffer.cursor, 1);
});
test('bracketed paste split across chunks is not executed as keys', async () => {
  const keys = [];
  const pastes = [];
  const input = new InputDecoder(
    (value, key) => keys.push([value, key.name]),
    (text) => pastes.push(text),
  );
  input.feed('\x1b[20');
  input.feed('0~正文\n/publish\x03');
  input.feed('\x1b[201');
  input.feed('~');
  assert.deepEqual(pastes, ['正文\n/publish\x03']);
  assert.equal(keys.length, 0);
  input.feed('a');
  assert.equal(keys.at(-1)[0], 'a');
});
test('image import copies original and export includes attachments', async (t) => {
  const workspace = await fixture(t);
  const session = await workspace.openArticle(await workspace.create());
  const image = path.join(workspace.root, '原图.png');
  await writeFile(image, 'image bytes');
  const relative = await workspace.importImage(session, image);
  const raw = post('图片', `![说明](${relative})`);
  const exported = await workspace.exportArticle(session, raw);
  assert.equal(await readFile(path.join(path.dirname(exported), relative), 'utf8'), 'image bytes');
  assert.equal(await readFile(image, 'utf8'), 'image bytes');
});
async function publishingFixture(t, build) {
  const workspace = await fixture(t);
  await mkdir(workspace.resolve('public'), { recursive: true });
  for (const file of ['astro.config.mjs', 'tsconfig.json', 'package.json'])
    await cp(path.join(sourceRoot, file), workspace.resolve(file));
  await atomicWrite(workspace.resolve('src/content/posts/a.md'), post('A', '公开 A'));
  const a = await workspace.openArticle(await workspace.get('a'));
  await workspace.save(a, post('A', '秘密 A'));
  const b = await workspace.create();
  const session = await workspace.openArticle(b);
  await workspace.save(session, post('B', '公开 B'));
  return { workspace, b, publisher: new Publisher(workspace, { build }) };
}
test('B candidate includes public A, never A private work or recovery files', async (t) => {
  const { workspace, b, publisher } = await publishingFixture(t, async (root) => {
    assert.match(await readFile(path.join(root, 'src/content/posts/a.md'), 'utf8'), /公开 A/);
    await assert.rejects(readFile(path.join(root, 'src/content/drafts', b.id)), { code: 'ENOENT' });
  });
  await publisher.prepare(b);
  assert.equal((await workspace.get(b.id)).status, '本地发布稿');
  assert.match(await readFile(workspace.resolve('src/content/posts/a.md'), 'utf8'), /公开 A/);
  assert.deepEqual(Object.keys(await publisher.pending()), [b.publicPath]);
});
test('failed candidate build leaves public tree unchanged and can retry', async (t) => {
  let fail = true;
  const { workspace, b, publisher } = await publishingFixture(t, async () => {
    if (fail) throw new Error('模拟构建失败');
  });
  await assert.rejects(publisher.prepare(b), /模拟构建失败/);
  await assert.rejects(readFile(workspace.resolve(b.publicPath)), { code: 'ENOENT' });
  assert.equal((await workspace.get(b.id)).status, '草稿');
  fail = false;
  await publisher.prepare(b);
  assert.equal((await workspace.get(b.id)).status, '本地发布稿');
});
test('sync refuses unrelated worktree changes without staging anything', async (t) => {
  const { workspace, b, publisher } = await publishingFixture(t, async () => {});
  await run('git', ['init'], workspace.root);
  await atomicWrite(
    workspace.resolve('.gitignore'),
    'src/content/drafts/\n.beacon/\nnode_modules/\n',
  );
  await run('git', ['add', '.'], workspace.root);
  await run(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline'],
    workspace.root,
  );
  await publisher.prepare(b);
  await writeFile(workspace.resolve('unrelated.txt'), 'private');
  await assert.rejects(publisher.sync(), /发布范围外/);
  assert.equal(await run('git', ['diff', '--cached', '--name-only'], workspace.root), '');
});

test('export makes public image references portable', async (t) => {
  const workspace = await fixture(t);
  await atomicWrite(workspace.resolve('public/images/picture.png'), 'public image');
  const session = await workspace.openArticle(await workspace.create());
  const exported = await workspace.exportArticle(
    session,
    post('带图', '![图注](/images/picture.png)'),
  );
  const raw = await readFile(exported, 'utf8');
  assert.doesNotMatch(raw, /\(\/images\//);
  const target = raw.match(/!\[图注\]\(([^)]+)\)/)[1];
  assert.equal(await readFile(path.join(path.dirname(exported), target), 'utf8'), 'public image');
});
test('public backups are not returned as editable articles', async (t) => {
  const workspace = await fixture(t);
  await atomicWrite(workspace.resolve('src/content/posts/old.agent-backup-123.md'), post('备份'));
  assert.deepEqual(await workspace.list(), []);
});
test('independent sessions cannot silently replace each other', async (t) => {
  const workspace = await fixture(t);
  const row = await workspace.create();
  const a = await workspace.openArticle(row);
  const b = await workspace.openArticle(row);
  await workspace.save(a, '第一会话');
  await assert.rejects(workspace.save(b, '第二会话'), ConflictError);
  assert.equal(await readFile(a.file, 'utf8'), '第一会话');
});

test('confirmed sync to a local bare remote includes only prepared content', async (t) => {
  const { workspace, b, publisher } = await publishingFixture(t, async () => {});
  const remote = await mkdtemp(path.join(os.tmpdir(), 'beacon-bare-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await run('git', ['init', '--bare'], remote);
  await run('git', ['init', '-b', 'main'], workspace.root);
  await run('git', ['config', 'user.name', 'Test'], workspace.root);
  await run('git', ['config', 'user.email', 'test@example.invalid'], workspace.root);
  await atomicWrite(
    workspace.resolve('.gitignore'),
    'src/content/drafts/\n.beacon/\nnode_modules/\n',
  );
  await run('git', ['add', '.'], workspace.root);
  await run('git', ['commit', '-m', 'baseline'], workspace.root);
  await run('git', ['remote', 'add', 'origin', remote], workspace.root);
  await run('git', ['push', '-u', 'origin', 'main'], workspace.root);
  await publisher.prepare(b);
  assert.equal(await publisher.sync(), '已推送，部署待确认');
  assert.deepEqual(await publisher.pending(), {});
  const changed = (
    await run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], workspace.root)
  ).trim();
  assert.equal(changed, b.publicPath);
  assert.match(await run('git', ['show', 'main:src/content/posts/a.md'], remote), /公开 A/);
  assert.doesNotMatch(await run('git', ['show', 'main:src/content/posts/a.md'], remote), /秘密 A/);
});
