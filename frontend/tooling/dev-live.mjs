#!/usr/bin/env node
// One command for the console against the real backend on the workshop VM:
//   1. makes sure uvicorn is running on the VM (starts it if the VM rebooted or it crashed),
//   2. keeps an SSH tunnel localhost:RW_LOCAL_PORT -> VM:8000 open (reconnects when it drops),
//   3. runs `next dev` pointed at the tunnel, once the API answers through it (so no proxy errors at start).
// A watchdog re-checks every 20 s while it runs. Ctrl-C stops the tunnel and Next only; the VM backend
// is shared with the team, so it keeps running.
//
//   pnpm dev:live            everything
//   pnpm backend:status      is the VM backend up?
//   pnpm backend:restart     restart uvicorn on the VM (after pulling backend changes there)
//   pnpm backend:logs        follow the VM backend log
//
// Override with env: RW_VM (ssh alias), RW_LOCAL_PORT, RW_BACKEND_DIR (on the VM).
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VM = process.env.RW_VM ?? 'bc-afthabshiraz';
const LOCAL_PORT = Number(process.env.RW_LOCAL_PORT ?? 8001);
const BACKEND_DIR = process.env.RW_BACKEND_DIR ?? '~/Real_time_VIdeo_Agents/backend';
const API = `http://127.0.0.1:${LOCAL_PORT}`;   // not localhost: Node would try ::1 first and log a refusal
const FRONTEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];

const colour = { vm: 35, tunnel: 36, web: 32, dev: 33 };
const say = (who, msg) => console.log(`\x1b[${colour[who] ?? 0}m[${who}]\x1b[0m ${msg}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs on the VM. Idempotent: never starts a second uvicorn. The process name is assembled from $UV so
// pgrep/pkill never match the ssh shell carrying these lines (its command line holds the script text).
const UV = 'UV=uvicorn; P="$UV app.main:app";';
const REMOTE_ENSURE = `${UV}
cd ${BACKEND_DIR} || { echo "missing ${BACKEND_DIR}"; exit 3; }
if curl -sf -m 3 -o /dev/null localhost:8000/api/videos; then echo up; exit 0; fi
if pgrep -f "$P" >/dev/null; then echo booting; exit 0; fi
mkdir -p state
setsid nohup .venv/bin/$UV app.main:app --host 127.0.0.1 --port 8000 >> state/uvicorn.log 2>&1 < /dev/null &
echo started`;
const REMOTE_HEALTH = 'curl -sf -m 3 -o /dev/null localhost:8000/api/videos && echo up || echo down';
const REMOTE_STOP = `${UV} pkill -f "$P"; for i in $(seq 1 20); do pgrep -f "$P" >/dev/null || exit 0; sleep 0.5; done; pkill -9 -f "$P"; true`;

// Async, so the backend check and the tunnel start at the same time (each ssh pays the cloudflared handshake).
function ssh(script, { inherit = false } = {}) {
  return new Promise(done => {
    const child = spawn('ssh', [...SSH_OPTS, VM, script], { stdio: inherit ? 'inherit' : 'pipe' });
    let out = '', err = '';
    child.stdout?.on('data', d => { out += d; });
    child.stderr?.on('data', d => { err += d; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', code => { clearTimeout(timer); done({ ok: code === 0, out: out.trim(), err: err.trim() }); });
  });
}

async function ensureBackend() {
  const r = await ssh(REMOTE_ENSURE);
  if (!r.ok) {
    say('vm', `can't reach ${VM}: ${r.err || r.out || 'ssh failed'}`);
    return false;
  }
  if (r.out === 'up') return true;
  say('vm', r.out === 'started' ? 'backend was down; started uvicorn' : 'backend is booting');
  for (let i = 0; i < 45; i++) {          // loading the store from VastDB takes a few seconds
    await sleep(2000);
    if ((await ssh(REMOTE_HEALTH)).out === 'up') { say('vm', 'backend up'); return true; }
  }
  say('vm', `backend still not answering; see: pnpm backend:logs`);
  return false;
}

async function apiUp() {
  try {
    const res = await fetch(`${API}/api/videos`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

function portOwner() {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${LOCAL_PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return (r.stdout ?? '').split('\n')[1]?.trim();
}

let tunnel = null;
let web = null;
let stopping = false;

function startTunnel() {
  tunnel = spawn('ssh', [...SSH_OPTS, '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `${LOCAL_PORT}:localhost:8000`, VM],
    { stdio: ['ignore', 'ignore', 'pipe'] });  // -L binds 127.0.0.1 (and ::1) on this Mac
  tunnel.stderr.on('data', d => say('tunnel', d.toString().trim()));
  tunnel.on('exit', code => {
    tunnel = null;
    if (!stopping) say('tunnel', `closed (code ${code}); the watchdog will reopen it`);
  });
  say('tunnel', `localhost:${LOCAL_PORT} -> ${VM}:8000`);
}

async function ensureTunnel() {
  if (tunnel) return;
  if (await apiUp()) { say('tunnel', `reusing the tunnel already on :${LOCAL_PORT}`); return; }
  const owner = portOwner();
  if (owner) {
    say('tunnel', `port ${LOCAL_PORT} is taken by something that isn't the backend:\n  ${owner}\n  free it or set RW_LOCAL_PORT`);
    return;
  }
  startTunnel();
}

async function waitForApi(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until && !stopping) {
    if (await apiUp()) return true;
    await sleep(1000);
  }
  return false;
}

async function watchdog() {
  let failures = 0;
  for (;;) {
    await sleep(20_000);
    if (stopping) return;
    if (await apiUp()) { failures = 0; continue; }
    failures += 1;
    if (failures < 2) continue;            // one slow answer isn't an outage
    say('dev', 'backend unreachable; checking the VM and the tunnel');
    await ensureBackend();
    if (tunnel && !(await apiUp())) { tunnel.kill(); await sleep(1000); }
    await ensureTunnel();
    failures = 0;
  }
}

/** The FastAPI backend serves VSS search (POST /api/search), so switch it on, keeping any capabilities already set. */
function capabilities() {
  let own = {};
  try { own = JSON.parse(process.env.NEXT_PUBLIC_API_CAPABILITIES || '{}'); } catch { say('web', 'ignoring NEXT_PUBLIC_API_CAPABILITIES: not JSON'); }
  return JSON.stringify({ topicSearch: true, ...own });
}

function startWeb() {
  web = spawn('pnpm', ['dev'], {
    cwd: FRONTEND_DIR,
    stdio: 'inherit',
    env: { ...process.env, NEXT_PUBLIC_DATA_SOURCE: 'http', RAIGHTWAY_API_URL: API, NEXT_PUBLIC_API_CAPABILITIES: capabilities() },
  });
  web.on('exit', code => { if (!stopping) { say('web', `next dev exited (code ${code})`); shutdown(code ?? 1); } });
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  tunnel?.kill();
  web?.kill('SIGINT');
  say('dev', `stopped the tunnel and Next; the backend on ${VM} keeps running`);
  setTimeout(() => process.exit(code), 500);
}

async function main() {
  const command = process.argv[2] ?? 'dev';
  if (command === 'status') {
    const r = await ssh(REMOTE_HEALTH);
    say('vm', r.ok ? `backend ${r.out}` : `can't reach ${VM}: ${r.err}`);
    say('tunnel', (await apiUp()) ? `:${LOCAL_PORT} answers` : `nothing answering on :${LOCAL_PORT}`);
    return;
  }
  if (command === 'restart') {
    say('vm', 'stopping uvicorn');
    await ssh(REMOTE_STOP);
    process.exit((await ensureBackend()) ? 0 : 1);
  }
  if (command === 'logs') {
    await ssh(`tail -n 50 -F ${BACKEND_DIR}/state/uvicorn.log`, { inherit: true });
    return;
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  // Tunnel and backend check run together; Next starts once the API answers through the tunnel.
  await Promise.all([ensureTunnel(), ensureBackend()]);
  const ready = await waitForApi(90_000);
  say('dev', ready ? `backend reachable: console -> ${API} -> ${VM}`
    : 'backend not reachable yet; starting the console anyway (it shows "backend down" until it is)');
  if (!stopping) startWeb();
  watchdog();
}

main();
