// nod-relay-agent — Railway stand-in for the Docker exec channel of Nod.
//
// Upstream Nod (n8n-io/nod, Apache-2.0) lets its server run commands in the
// workspace and browser containers only through a restricted Docker proxy
// (upstream: deployment/self-host/docker-proxy.mjs). Railway services have no
// Docker socket, so the Workspace and Browser services each run this agent on
// the private network instead. The server's docker shim connects, presents a
// shared token, and receives docker-exec-like stdio plus an exit code back.
//
// The allow rules below implement the same contract as upstream's proxy:
//   browser:   user "node", no workdir, command exactly `node /app/bridge.mjs`
//   workspace: user "node" in /var/tmp, or in /workspace/<thread-uuid>
//   workspace: connected-CLI users "<uid 2xxxx-5xxxx>:1002" in /var/tmp only
// Anything else is refused. Commands run with a scrubbed, fixed environment
// and, when this agent runs as root, through setpriv with supplementary
// groups cleared, no-new-privs set, and an empty capability bounding set.
//
// Wire format: the client sends one JSON header line
// {token, user, workdir, cmd}, then raw stdin bytes, then half-closes.
// Replies are frames [type u8][length u32be][payload]:
//   1 = stdout, 2 = stderr, 3 = exit (payload is the int32be exit code).
// Refusals are a stderr frame followed by an exit frame with code 126.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, chownSync } from 'node:fs';
import { join } from 'node:path';

const MODE = process.env.NOD_RELAY_MODE;
const TOKEN = Buffer.from(process.env.NOD_RELAY_TOKEN || '');
const PORT = Number(process.env.NOD_RELAY_PORT || 7070);
const TESTING = process.env.NOD_RELAY_TEST === '1';
const WORKSPACE_ROOT = process.env.NOD_RELAY_WORKSPACE_ROOT || '/workspace';
const BRIDGE_PATH = process.env.NOD_RELAY_BROWSER_BRIDGE || '/app/bridge.mjs';
const HEADER_LIMIT = 64 * 1024;

if (MODE !== 'workspace' && MODE !== 'browser')
  throw new Error('NOD_RELAY_MODE must be "workspace" or "browser".');
if (TOKEN.length < 32) throw new Error('NOD_RELAY_TOKEN must be at least 32 characters.');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
if (!IS_ROOT && !TESTING) throw new Error('nod-relay-agent must run as root so it can drop privileges.');

// The executed command never sees this process's environment (which holds the
// relay token and platform variables). It gets exactly this fixed set, the
// same values the upstream images export.
const BASE_ENV =
  MODE === 'workspace'
    ? {
        PATH: '/opt/nod-artifacts/bin:/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: 'C.UTF-8',
        NPM_CONFIG_PREFIX: '/home/node/.local',
        PIPX_HOME: '/home/node/.local/pipx',
        PIPX_BIN_DIR: '/home/node/.local/bin',
      }
    : {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: 'C.UTF-8',
      };
if (TESTING && process.env.NOD_RELAY_TEST_PATH) BASE_ENV.PATH = process.env.NOD_RELAY_TEST_PATH;

const NODE_UID = 1000;
const NODE_GID = 1000;
const THREAD_WORKDIR = /^\/workspace\/[0-9a-f-]{36}$/;
const CONNECTED_USER = /^([2-5]\d{4}):1002$/;

// Returns a refusal string, or an execution plan
// {file, args, uid, gid, cwd, home, createDir}.
function authorize(header) {
  const presented = Buffer.from(typeof header?.token === 'string' ? header.token : '');
  if (presented.length !== TOKEN.length || !timingSafeEqual(presented, TOKEN)) return 'bad token';
  const { user, workdir, cmd } = header ?? {};
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((p) => typeof p !== 'string' || p.length === 0 || p.includes('\0')))
    return 'bad command';

  if (MODE === 'browser') {
    if (user !== 'node') return 'browser commands run as node only';
    if (workdir !== undefined && workdir !== '') return 'browser commands have no workdir';
    if (cmd.length !== 2 || cmd[0] !== 'node' || cmd[1] !== '/app/bridge.mjs')
      return 'browser runs the bridge only';
    return {
      file: TESTING ? process.execPath : 'node',
      args: [BRIDGE_PATH],
      uid: NODE_UID,
      gid: NODE_GID,
      cwd: TESTING ? undefined : '/app',
      home: '/home/node',
    };
  }

  // workspace mode
  if (user === 'node') {
    if (workdir === '/var/tmp')
      return { file: cmd[0], args: cmd.slice(1), uid: NODE_UID, gid: NODE_GID, cwd: '/var/tmp', home: '/home/node' };
    if (typeof workdir !== 'string' || !THREAD_WORKDIR.test(workdir))
      return 'workdir must be a thread workspace or /var/tmp';
    return {
      file: cmd[0],
      args: cmd.slice(1),
      uid: NODE_UID,
      gid: NODE_GID,
      cwd: join(WORKSPACE_ROOT, workdir.slice('/workspace/'.length)),
      home: '/home/node',
      createDir: true,
    };
  }
  const connected = CONNECTED_USER.exec(typeof user === 'string' ? user : '');
  if (!connected) return 'unknown user';
  if (workdir !== '/var/tmp') return 'connected CLIs run in /var/tmp only';
  return {
    file: cmd[0],
    args: cmd.slice(1),
    uid: Number(connected[1]),
    gid: 1002,
    cwd: '/var/tmp',
    home: '/',
  };
}

// Builds the argv that runs the plan with a scrubbed environment and, as
// root, dropped privileges: no supplementary groups, no new privileges, no
// capabilities. Falls back to a plain spawn when setpriv is unavailable
// (test machines), which the tests detect and skip the hardening checks for.
function buildArgv(plan) {
  const envArgs = Object.entries({ ...BASE_ENV, HOME: plan.home }).map(([k, v]) => `${k}=${v}`);
  const command = ['/usr/bin/env', '-i', ...envArgs, plan.file, ...plan.args];
  if (!IS_ROOT) return command;
  return [
    '/usr/bin/setpriv',
    '--reuid', String(plan.uid),
    '--regid', String(plan.gid),
    '--clear-groups',
    '--no-new-privs',
    '--bounding-set=-all',
    ...command,
  ];
}

function frame(type, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}
function exitFrame(code) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(code);
  return frame(3, b);
}
const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  socket.setKeepAlive(true, 15_000);
  let buffered = Buffer.alloc(0);
  let child = null;
  let finished = false;

  const refuse = (why) => {
    finished = true;
    socket.end(Buffer.concat([frame(2, Buffer.from(`nod-relay: refused: ${why}\n`)), exitFrame(126)]));
  };

  socket.on('data', (chunk) => {
    if (child) {
      if (!child.stdin.write(chunk)) {
        socket.pause();
        child.stdin.once('drain', () => socket.resume());
      }
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    const newline = buffered.indexOf(10);
    if (newline < 0) {
      if (buffered.length > HEADER_LIMIT) refuse('header too large');
      return;
    }
    let header;
    try {
      header = JSON.parse(buffered.subarray(0, newline).toString('utf8'));
    } catch {
      return refuse('bad header');
    }
    const rest = buffered.subarray(newline + 1);
    const plan = authorize(header);
    if (typeof plan === 'string') return refuse(plan);
    try {
      if (plan.createDir) {
        mkdirSync(plan.cwd, { recursive: true, mode: 0o700 });
        if (IS_ROOT) chownSync(plan.cwd, plan.uid, plan.gid);
      }
      const argv = buildArgv(plan);
      child = spawn(argv[0], argv.slice(1), {
        cwd: plan.cwd,
        env: {}, // env is set by `env -i` in argv; keep node's own env out
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return refuse(`spawn failed: ${error.message}`);
    }
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => socket.write(frame(1, d)));
    child.stderr.on('data', (d) => socket.write(frame(2, d)));
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      socket.end(Buffer.concat([frame(2, Buffer.from(`nod-relay: ${error.message}\n`)), exitFrame(127)]));
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      socket.end(exitFrame(code ?? 128 + (SIGNAL_NUMBERS[signal] ?? 1)));
    });
    if (rest.length) child.stdin.write(rest);
  });
  socket.on('end', () => child?.stdin.end());
  socket.on('error', () => {});
  socket.on('close', () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
  });
});

server.listen({ port: PORT, host: '::', ipv6Only: false }, () => {
  console.log(`nod-relay-agent (${MODE}) listening on [::]:${PORT}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
