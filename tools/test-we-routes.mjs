import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { registerWeRoutes } from '../we/routes.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'we-routes-'));
let close, server;
try {
  const projects = path.join(root, 'projects');
  for (const [name, type, file] of [['scene', 'scene', 'scene.json'], ['video','video','movie.mp4'], ['web','web','index.html']]) {
    const dir = path.join(projects, 'myprojects', name); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ title: name, type, file }));
    await fs.writeFile(path.join(dir, file), type === 'web' ? '<html>fixture</html>' : '0123456789');
    if (type === 'scene') await fs.writeFile(path.join(dir, 'scene.pkg'), 'fixture');
  }
  await fs.writeFile(path.join(root, 'wallpaper64.exe'), 'not executable; launcher is a stub');
  await fs.writeFile(path.join(root, 'private.txt'), 'not served');
  const routes = [], launches = []; let discoveries = 0, running = true, jobs = 0, complete;
  close = registerWeRoutes({ register(route) { routes.push(route); return () => {}; } }, {
    discoverPaths: async () => { discoveries++; return { found: true, localProjectsDir: projects, wallpaperEngineDir: root }; },
    stillsDir: path.join(root, 'stills'),
    bridgeStatus: async () => ({ running, available: false, rpcSupported: false }),
    spawnLauncher: async (exe, args) => launches.push({ exe, args }),
    composeWorker: async () => { jobs++; return new Promise(resolve => { complete = resolve; }); },
  });
  server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    const route = routes.find(r => r.kind === 'exact' && r.path === pathname)
      || routes.find(r => r.kind === 'prefix' && pathname.startsWith(r.path + '/'));
    try { if (route) await route.handler(req, res); else { res.writeHead(404); res.end(); } }
    catch(error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, options) => fetch(base + '/bga/we/' + p, options);
  const library = await (await get('library.json')).json();
  assert.equal(library.entries.length, 3);
  await get('library.json'); assert.equal(discoveries, 1);
  await get('library.json?force=1'); assert.equal(discoveries, 2);
  const scene = library.entries.find(e => e.type === 'scene'), video = library.entries.find(e => e.type === 'video'), web = library.entries.find(e => e.type === 'web');
  assert.equal((await (await get('status')).json()).bridge.running, true, 'running with no port is not offline');
  const media = `media/${video.id}/movie.mp4`;
  assert.equal(await (await get(media)).text(), '0123456789');
  const range = await get(media, { headers: { Range: 'bytes=2-5' } });
  assert.equal(range.status, 206); assert.equal(await range.text(), '2345');
  assert.equal((await get(media, { headers: { Range: 'bytes=100-' } })).status, 416);
  assert.equal((await get(`media/${web.id}/index.html`)).headers.get('content-type'), 'text/html');
  assert.equal((await get(`media/${scene.id}/scene.pkg`)).status, 403);
  assert.equal((await get(`media/${web.id}/%2e%2e%2f%2e%2e%2f%2e%2e%2fprivate.txt`)).status, 404);
  console.log('PASS library/media HTTP: cache / refresh / local IDs / video ranges / web / denied files');
  const post = { method: 'POST' };
  assert.equal((await get(`still?id=${scene.id}`, post)).status, 202);
  // 202 只保证**受理**：真正调到 composeWorker 还隔着 compose 里那几个 await，
  // 而"响应到手"与"任务已经起跑"之间没有先后保证 —— 拿它当同步断言是竞态。
  // 实测：Node 20.20.2 / 24.21.0 上响应先到（jobs 还是 0），Node 22 上恰好反过来 ⇒
  // CI 的 test(20)/test(24) 两个 job 就红在这一行（不是产品漏了去重，去重在 start() 里是同步的）。
  for (let i = 0; i < 50 && jobs === 0; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(jobs, 1, '第一次 POST 之后要起一个任务');
  await get(`still?id=${scene.id}`, post); assert.equal(jobs, 1, '同一个 id 的第二个 POST 不许再起一个任务');
  assert.equal((await get(`still/${scene.id}.webp`, { method: 'HEAD' })).status, 404);
  // Other requests continue while composition waits.
  assert.equal((await get('status')).status, 200);
  complete({ buffer: Buffer.from('webp fixture'), width: 4, height: 4 });
  let state;
  for (let i = 0; i < 50; i++) { state = await (await get(`still?id=${scene.id}`)).json(); if (state.state === 'ready') break; await new Promise(r => setTimeout(r, 10)); }
  assert.equal(state.state, 'ready');
  assert.equal(await (await get(`still/${scene.id}.webp`)).text(), 'webp fixture');
  assert.equal((await get('still?id=../../bad', post)).status, 400);
  console.log('PASS still HTTP: immediate acceptance / single job / responsive status / local output / ID validation');
  assert.equal((await get(`open-in-we?id=${scene.id}`)).status, 405);
  const launched = await (await get(`open-in-we?id=${scene.id}`, post)).json();
  assert.equal(launched.targeted, true);
  assert.deepEqual(launches[0].args, ['-control','openWallpaper','-file',await fs.realpath(path.join(scene.path,'project.json'))]);
  running = false;
  const uiOnly = await (await get(`open-in-we?id=${web.id}`, post)).json();
  assert.equal(uiOnly.targeted, false); assert.deepEqual(launches[1].args, ['-control','open']);
  console.log('PASS official CLI: local project.json / POST only / truthful UI-only fallback');
} finally {
  close?.(); if (server) await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
