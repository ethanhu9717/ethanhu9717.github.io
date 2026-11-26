import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, symlink, access, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../scripts/install-admin.mjs', import.meta.url));
async function fixture(t) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'beacon-install-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const project = path.join(temp, "写作 '$draft' $(unused)");
  const bin = path.join(temp, 'bin');
  await mkdir(path.join(project, 'scripts'), { recursive: true });
  await mkdir(bin);
  await symlink(process.execPath, path.join(bin, 'node'));
  await copyFile(installer, path.join(project, 'scripts/install-admin.mjs'));
  await writeFile(path.join(project, 'scripts/admin.mjs'),
    'console.log(JSON.stringify({ entry: import.meta.url, args: process.argv.slice(2), cwd: process.cwd() }));\n');
  const env = { ...process.env, PATH: bin };
  delete env.BLOG_ADMIN_INSTALL_DIR;
  const install = (overrides = {}) => spawnSync(process.execPath,
    [path.join(project, 'scripts/install-admin.mjs')], { cwd: temp, env: { ...env, ...overrides }, encoding: 'utf8' });
  return { temp, project, bin, env, install };
}

test('installation chooses a writable PATH directory and launches from unrelated directories', async (t) => {
  const f = await fixture(t);
  assert.equal(f.install().status, 0);
  for (const command of ['beacon', 'myblog']) {
    for (const cwd of [f.project, f.temp]) {
      const result = spawnSync(command, ['--check', '中文 空格', '$literal'], { cwd, env: f.env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(fileURLToPath(output.entry), path.join(f.project, 'scripts/admin.mjs'));
      assert.deepEqual(output.args, ['--check', '中文 空格', '$literal']);
      assert.equal(output.cwd, cwd);
    }
  }
  assert.equal(f.install().status, 0, 'reinstall accepts its own quoted wrapper');
});

test('explicit installation outside PATH prints an executable repair command', async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.temp, "单独 '$bin'");
  const result = f.install({ BLOG_ADMIN_INSTALL_DIR: bin });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /尚未加入 PATH/);
  assert.doesNotMatch(result.stdout, /现在可以在任意目录运行/);
  const repair = result.stdout.split('\n').find((line) => line.startsWith('export PATH='));
  assert.ok(repair);
  const launched = spawnSync('/bin/sh', ['-c', `${repair}\nexec beacon --check`], { cwd: f.temp, env: f.env, encoding: 'utf8' });
  assert.equal(launched.status, 0, launched.stderr);
  assert.deepEqual(JSON.parse(launched.stdout).args, ['--check']);
});

test('an unrelated existing alias prevents overwriting either command', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.bin, 'myblog'), 'unrelated command\n');
  const result = f.install();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /myblog 已由其他程序占用/);
  assert.equal(await readFile(path.join(f.bin, 'myblog'), 'utf8'), 'unrelated command\n');
  await assert.rejects(access(path.join(f.bin, 'beacon')));
});

test('relative override resolves to an absolute launcher and works without PATH', async (t) => {
  const f = await fixture(t);
  const result = f.install({ BLOG_ADMIN_INSTALL_DIR: 'relative-bin', PATH: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(path.join(f.temp, 'relative-bin', 'beacon')));
  assert.match(result.stdout, /export PATH=/);
});
