import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, digest, readOptional } from './storage.mjs';
import { metadata, splitDocument, updateMetadata } from './document.mjs';

export function run(command, args, cwd, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (input !== null) child.stdin.end(input);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${command} 失败 (${code})\n${output.slice(-6000)}`)),
    );
  });
}
export class Publisher {
  constructor(workspace, { build = (root) => run('npm', ['run', 'build'], root) } = {}) {
    this.workspace = workspace;
    this.build = build;
    this.busy = false;
  }
  async pending() {
    return JSON.parse(
      (await readOptional(path.join(this.workspace.stateDir, 'pending.json'))) || '{}',
    );
  }
  async prepare(row) {
    if (this.busy) throw new Error('已有发布操作进行中');
    this.busy = true;
    const workspace = this.workspace;
    let temporary;
    let unlock;
    let articleUnlock;
    try {
      unlock = await workspace.lock('publisher');
      const session = await workspace.openArticle(row);
      const raw = session.raw;
      const document = splitDocument(raw);
      const info = metadata(raw);
      if (document.error) throw new Error(document.error);
      if (!String(info.title || '').trim()) throw new Error('发布前请填写标题');
      if (!document.body.trim()) throw new Error('正文为空');
      const existing = await readOptional(workspace.resolve(row.publicPath));
      temporary = await mkdtemp(path.join(os.tmpdir(), 'beacon-publish-'));
      for (const item of ['src', 'public', 'astro.config.mjs', 'tsconfig.json', 'package.json']) {
        await cp(workspace.resolve(item), path.join(temporary, item), {
          recursive: true,
          filter: (file) => {
            const relative = path.relative(workspace.root, file);
            return (
              !relative.startsWith('src/content/drafts') &&
              !/\.agent-backup-|\/\.[^/]+\.md/.test(relative)
            );
          },
        });
      }
      await symlink(workspace.resolve('node_modules'), path.join(temporary, 'node_modules'));
      let body = document.body;
      const assets = new Map();
      const matches = [...body.matchAll(/!\[([^\]]*)\]\(([^)]+)\)|!\[\[([^\]]+)\]\]/g)];
      for (const match of matches) {
        let target = (match[2] || match[3].split('|')[0]).trim().replace(/^<|>$/g, '');
        if (/^https?:\/\//.test(target)) continue;
        if (target.startsWith('/images/')) {
          const file = path.resolve(workspace.root, 'public', '.' + decodeURIComponent(target));
          if (!file.startsWith(workspace.resolve('public/images') + path.sep))
            throw new Error('无效图片路径');
          await readFile(file);
          continue;
        }
        if (/^[a-z]+:/i.test(target) || path.isAbsolute(target))
          throw new Error(`请先导入本地图片：${target}`);
        const source = path.resolve(path.dirname(session.file), decodeURIComponent(target));
        if (!source.startsWith(path.dirname(session.file) + path.sep))
          throw new Error(`图片超出文章目录：${target}`);
        const actual = await realpath(source);
        if (!actual.startsWith((await realpath(path.dirname(session.file))) + path.sep))
          throw new Error('图片链接超出文章目录，请先导入');
        const bytes = await readFile(actual);
        const extension = path.extname(source).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'].includes(extension))
          throw new Error('不支持的图片格式');
        const asset = `public/images/beacon/${digest(bytes)}${extension}`;
        assets.set(asset, bytes);
        await atomicWrite(path.join(temporary, asset), bytes);
        body = body.replace(
          match[0],
          `![${match[1] || match[3]?.split('|')[1] || ''}](/${asset.slice(7)})`,
        );
      }
      const candidate = updateMetadata(document.header + body, {
        title: String(info.title).trim(),
        date: info.date || new Date().toISOString().slice(0, 10),
        category: info.category || 'Daily',
        tags: info.tags || [],
        description:
          info.description ||
          body
            .replace(/[#*`>]/g, '')
            .trim()
            .slice(0, 160),
        draft: false,
      });
      await atomicWrite(path.join(temporary, row.publicPath), candidate);
      await this.build(temporary);
      articleUnlock = await workspace.lock(row.id);
      if (
        (await readOptional(session.file)) !== raw ||
        (await readOptional(workspace.resolve(row.publicPath))) !== existing
      )
        throw new Error('构建期间文章发生变化，请重新准备发布');
      const pending = await this.pending();
      // Record the confirmed transaction first. A partial promotion blocks sync by hash.
      for (const [file, bytes] of assets) pending[file] = digest(bytes);
      pending[row.publicPath] = digest(candidate);
      await atomicWrite(path.join(workspace.stateDir, 'pending.json'), JSON.stringify(pending));
      for (const [file, bytes] of assets) await atomicWrite(workspace.resolve(file), bytes);
      await atomicWrite(workspace.resolve(row.publicPath), candidate);
      // Preserve editable local image links in the private working copy.
      if (!row.published) {
        const { rename } = await import('node:fs/promises');
        const work = workspace.resolve(`.beacon/work/${row.id}`);
        await mkdir(path.dirname(work), { recursive: true });
        await rename(session.file, work);
        const assetsDir = `${path.basename(session.file, path.extname(session.file))}.assets`;
        try {
          await rename(
            path.join(path.dirname(session.file), assetsDir),
            path.join(path.dirname(work), assetsDir),
          );
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      await atomicWrite(
        path.join(workspace.stateDir, `published-${digest(row.id)}.json`),
        JSON.stringify({ work: digest(raw), public: digest(candidate) }),
      );
      return '发布稿已准备；使用 /sync 明确确认后推送';
    } finally {
      this.busy = false;
      await articleUnlock?.();
      await unlock?.();
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
  async sync(message = 'Publish Beacon articles') {
    const unlock = await this.workspace.lock('publisher');
    try {
      return await this.syncConfirmed(message);
    } finally {
      await unlock();
    }
  }
  async syncConfirmed(message) {
    const workspace = this.workspace;
    const pending = await this.pending();
    const files = Object.keys(pending);
    if (!files.length) throw new Error('没有已确认的发布稿');
    const staged = await run('git', ['diff', '--cached', '--name-only'], workspace.root);
    if (staged.trim()) throw new Error('已有暂存改动，请先处理，Beacon 不会夹带提交');
    const status = await run(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      workspace.root,
    );
    const changes = status.split('\0').filter(Boolean);
    for (const entry of changes)
      if (!pending[entry.slice(3)] || /R|C/.test(entry.slice(0, 2)))
        throw new Error(`存在发布范围外的改动：${entry.slice(3)}`);
    const confirmed = new Map();
    for (const file of files) {
      const bytes = await readFile(workspace.resolve(file));
      if (digest(bytes) !== pending[file]) throw new Error(`发布稿已变化，请重新准备：${file}`);
      confirmed.set(file, bytes);
    }
    const retryPath = path.join(workspace.stateDir, 'sync-commit.json');
    const retry = JSON.parse((await readOptional(retryPath)) || 'null');
    let upstream;
    try {
      upstream = (
        await run('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], workspace.root)
      ).trim();
    } catch {
      throw new Error('当前分支尚未配置上游，请先完成 Git 连接设置');
    }
    const ahead = (await run('git', ['rev-list', `${upstream}..HEAD`], workspace.root))
      .trim()
      .split('\n')
      .filter(Boolean);
    if (ahead.length && !(retry && ahead.length === 1 && ahead[0] === retry.commit))
      throw new Error('存在 Beacon 发布记录以外的未推送提交，请先处理');
    if (changes.length && ahead.length) throw new Error('上次发布尚未推送，请先重试该次同步');
    if (changes.length) {
      await run('git', ['add', '--', ...files], workspace.root);
      const stagedFiles = (
        await run('git', ['diff', '--cached', '--name-only', '-z'], workspace.root)
      )
        .split('\0')
        .filter(Boolean);
      if (stagedFiles.some((file) => !confirmed.has(file)))
        throw new Error('暂存区在同步过程中发生变化，已停止提交');
      for (const file of files) {
        const expected = (
          await run('git', ['hash-object', '--stdin'], workspace.root, confirmed.get(file))
        ).trim();
        const actual = (await run('git', ['rev-parse', `:${file}`], workspace.root)).trim();
        if (actual !== expected) throw new Error(`暂存内容已变化，已停止提交：${file}`);
      }
      await run('git', ['commit', '-m', message], workspace.root);
      await atomicWrite(
        retryPath,
        JSON.stringify({
          commit: (await run('git', ['rev-parse', 'HEAD'], workspace.root)).trim(),
        }),
      );
    }
    await run('git', ['push'], workspace.root);
    await atomicWrite(path.join(workspace.stateDir, 'pending.json'), '{}');
    await rm(retryPath, { force: true });
    return '已推送，部署待确认';
  }
}
