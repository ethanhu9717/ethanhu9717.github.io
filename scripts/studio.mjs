#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStudioServer } from './beacon/studio-server.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const workspace = process.env.BEACON_WORKSPACE || projectRoot;
const requestedPort = process.env.BEACON_STUDIO_PORT || '0';
if (!/^(?:0|[1-9]\d{0,4})$/.test(requestedPort) || Number(requestedPort) > 65535)
  throw new Error('BEACON_STUDIO_PORT 必须是 0 到 65535 的整数');

const studio = await startStudioServer({
  root: workspace,
  port: Number(requestedPort),
  staticDir: path.join(projectRoot, 'scripts', 'beacon', 'studio'),
});

console.log('Beacon Studio 已启动');
console.log(`工作区：${studio.workspace.root}`);
console.log(`访问：${studio.url}`);
console.log('按 Ctrl+C 停止服务。');

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await studio.stop();
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
