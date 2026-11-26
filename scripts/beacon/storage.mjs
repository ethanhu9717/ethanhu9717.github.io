import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  readdir,
  copyFile,
  stat,
  realpath,
  cp,
} from 'node:fs/promises';
import path from 'node:path';
import { metadata, updateMetadata } from './document.mjs';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
export async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    const directory = await open(path.dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}
export class ConflictError extends Error {
  constructor(disk) {
    super('文件已被其他编辑器修改');
    this.disk = disk;
    this.code = 'CONFLICT';
  }
}
export class Workspace {
  constructor(root, { write = atomicWrite } = {}) {
    this.root = path.resolve(root);
    this.stateDir = path.join(this.root, '.beacon');
    this.write = write;
    this.queues = new Map();
  }
  resolve(relative) {
    const target = path.resolve(this.root, relative);
    if (!target.startsWith(this.root + path.sep)) throw new Error('路径超出工作区');
    return target;
  }
  recoveryPath(id) {
    return path.join(this.stateDir, 'recovery', `${digest(id)}.json`);
  }
  async initialize() {
    for (const dir of ['src/content/drafts', '.beacon/work', '.beacon/recovery'])
      await mkdir(this.resolve(dir), { recursive: true });
  }
  async list() {
    const result = [];
    for (const type of ['drafts', 'posts']) {
      const directory = this.resolve(`src/content/${type}`);
      const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
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
        const id = entry.name;
        const publicPath = `src/content/posts/${id}`;
        const draftPath = `src/content/drafts/${id}`;
        const workingPath = type === 'posts' ? `.beacon/work/${id}` : draftPath;
        const source = await readFile(this.resolve(`src/content/${type}/${id}`), 'utf8');
        const work = type === 'posts' ? await readOptional(this.resolve(workingPath)) : source;
        const data = metadata(work ?? source);
        const publishedState = JSON.parse(
          (await readOptional(path.join(this.stateDir, `published-${digest(id)}.json`))) || '{}',
        );
        const unchanged =
          work === source ||
          (work !== null &&
            digest(work) === publishedState.work &&
            digest(source) === publishedState.public);
        result.push({
          id,
          publicPath,
          workingPath,
          title: String(data.title || path.basename(id, path.extname(id))),
          date: String(data.date || id.slice(0, 8)),
          status:
            type === 'drafts'
              ? '草稿'
              : work !== null && !unchanged
                ? '有未发布修改'
                : '本地发布稿',
          published: type === 'posts',
          modified: (await stat(this.resolve(work === null ? publicPath : workingPath))).mtimeMs,
        });
      }
    }
    // A published article retains its private draft when publishing is interrupted.
    return result
      .filter(
        (row) => row.published || !result.some((other) => other.published && other.id === row.id),
      )
      .sort((a, b) => b.modified - a.modified);
  }
  async get(identifier) {
    const rows = await this.list();
    const matches = rows.filter(
      (row) => row.id === identifier || row.id.replace(/\.mdx?$/, '') === identifier,
    );
    if (matches.length !== 1) throw new Error('文章不存在或标识不唯一');
    return matches[0];
  }
  async create(date = '') {
    await this.initialize();
    const stamp = new Intl.DateTimeFormat('sv-SE', {
      timeZone: process.env.BLOG_TIMEZONE || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(new Date());
    const iso = date
      ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
      : stamp.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || new Date(iso).toISOString().slice(0, 10) !== iso)
      throw new Error('无效日期');
    const id = `${iso.replaceAll('-', '')}-${stamp.slice(-8).replaceAll(':', '')}-${randomUUID().slice(0, 8)}.md`;
    await this.write(
      this.resolve(`src/content/drafts/${id}`),
      updateMetadata('', {
        title: '',
        date: iso,
        category: 'Daily',
        tags: [],
        description: '',
        draft: true,
      }),
    );
    return this.get(id);
  }
  async openArticle(row) {
    await this.initialize();
    const file = this.resolve(row.workingPath);
    const unlock = await this.lock(row.id);
    try {
      if (row.published && (await readOptional(file)) === null) {
        const draft = await readOptional(this.resolve(`src/content/drafts/${row.id}`));
        await this.write(file, draft ?? (await readFile(this.resolve(row.publicPath), 'utf8')));
        const assets = `${path.basename(row.id, path.extname(row.id))}.assets`;
        const origin = path.dirname(
          this.resolve(draft === null ? row.publicPath : `src/content/drafts/${row.id}`),
        );
        try {
          await cp(path.join(origin, assets), path.join(path.dirname(file), assets), {
            recursive: true,
          });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      const raw = await readFile(file, 'utf8');
      const recoveryText = await readOptional(this.recoveryPath(row.id));
      let recovery = null;
      if (recoveryText) {
        try {
          recovery = JSON.parse(recoveryText);
        } catch {
          /* preserve damaged records for manual recovery */
        }
      }
      return {
        id: row.id,
        row,
        file,
        raw,
        saved: raw,
        revision: 0,
        sessionId: randomUUID(),
        recovery: recovery?.content !== raw ? recovery : null,
      };
    } finally {
      await unlock();
    }
  }
  save(session, raw, { force = false, expectedDisk } = {}) {
    // Capture identity and content before any asynchronous operation.
    const file = session.file;
    const id = session.id;
    const revision = ++session.revision;
    const previous = this.queues.get(file) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        await this.write(
          this.recoveryPath(id),
          JSON.stringify({ id, content: raw, base: session.saved, time: Date.now() }),
        );
        const unlock = await this.lock(id);
        try {
          const disk = await readOptional(file);
          if ((!force && disk !== session.saved) || (force && disk !== expectedDisk))
            throw new ConflictError(disk);
          await this.write(file, raw);
          session.saved = raw;
          return { revision, raw };
        } finally {
          await unlock();
        }
      });
    this.queues.set(file, task);
    task
      .finally(() => {
        if (this.queues.get(file) === task) this.queues.delete(file);
      })
      .catch(() => {});
    return task;
  }
  async lock(id) {
    const directory = path.join(this.stateDir, 'locks');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${digest(id)}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(file, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
        return () => rm(file, { force: true });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = Number(await readOptional(file));
        let alive = true;
        if (owner > 0) {
          try {
            process.kill(owner, 0);
          } catch (cause) {
            if (cause.code === 'ESRCH') alive = false;
          }
        } else alive = Date.now() - (await stat(file)).mtimeMs < 30000;
        if (alive) throw new Error('另一个 Beacon 正在保存此文章，请重试');
        await rm(file, { force: true });
      }
    }
    throw new Error('无法取得文章写入锁');
  }
  async discardRecovery(id) {
    await rm(this.recoveryPath(id), { force: true });
  }
  async loadState() {
    try {
      return JSON.parse((await readOptional(path.join(this.stateDir, 'state.json'))) || '{}');
    } catch {
      return {};
    }
  }
  async saveState(value) {
    await this.write(path.join(this.stateDir, 'state.json'), JSON.stringify(value));
  }
  async importImage(session, source) {
    source = source
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
      .replace(/\\ /g, ' ');
    const file = await realpath(source);
    const extension = path.extname(file).toLowerCase();
    if (
      !['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'].includes(extension) ||
      !(await stat(file)).isFile()
    )
      throw new Error('请选择本地图片文件');
    const bytes = await readFile(file);
    const name = `${digest(bytes).slice(0, 16)}${extension}`;
    const directory = path.join(
      path.dirname(session.file),
      `${path.basename(session.file, path.extname(session.file))}.assets`,
    );
    await mkdir(directory, { recursive: true });
    await copyFile(file, path.join(directory, name));
    return `${path.basename(directory)}/${name}`;
  }
  async exportArticle(session, raw) {
    const directory = this.resolve(
      `exports/${path.basename(session.id, path.extname(session.id))}-${Date.now()}`,
    );
    await mkdir(directory, { recursive: true });
    const assets = `${path.basename(session.id, path.extname(session.id))}.assets`;
    try {
      await cp(path.join(path.dirname(session.file), assets), path.join(directory, assets), {
        recursive: true,
        errorOnExist: true,
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const match of [...raw.matchAll(/!\[([^\]]*)\]\((\/images\/[^)]+)\)/g)]) {
      const source = await realpath(
        path.resolve(this.root, 'public', '.' + decodeURIComponent(match[2])),
      );
      if (!source.startsWith((await realpath(this.resolve('public/images'))) + path.sep))
        throw new Error('图片路径超出公开图片目录');
      const bytes = await readFile(source);
      const relative = `attachments/${digest(bytes).slice(0, 16)}${path.extname(source)}`;
      await this.write(path.join(directory, relative), bytes);
      raw = raw.replace(match[0], `![${match[1]}](${relative})`);
    }
    const file = path.join(directory, session.id);
    await this.write(file, raw);
    return file;
  }
}
