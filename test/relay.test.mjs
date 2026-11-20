// Relay contract tests for relay/docker (the shim) and
// relay/nod-relay-agent.mjs (the agent), run with plain node:
//
//   node --test test/relay.test.mjs
//
// The agents run in test mode (NOD_RELAY_TEST=1) against a temporary
// workspace root and a fixture bridge script, so no containers are needed.
// The tests exercise the real shim binary end to end over real sockets:
// stdio fidelity, exit codes, the upstream allow rules, token rejection,
// environment scrubbing, and privilege-drop hardening where the machine
// allows it (root + setpriv).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHIM = join(ROOT, 'relay', 'docker');
const AGENT = join(ROOT, 'relay', 'nod-relay-agent.mjs');
const TOKEN = 'test-relay-token-test-relay-token-0123456789';
const THREAD = '123e4567-e89b-42d3-a456-426614174000';
const WS_PORT = 17071;
const BR_PORT = 17072;

const tmp = mkdtempSync(join(tmpdir(), 'nod-relay-test-'));
const wsRoot = join(tmp, 'workspace');
mkdirSync(wsRoot, { recursive: true });
// Commands run as uid 1000 after the privilege drop, so the temp tree must
// be traversable by that uid (the repo checkout itself may not be).
chmodSync(tmp, 0o755);
chmodSync(wsRoot, 0o755);
const bridgeFixture = join(tmp, 'bridge.mjs');
copyFileSync(join(ROOT, 'test', 'fixtures', 'bridge.mjs'), bridgeFixture);
chmodSync(bridgeFixture, 0o644);
const configDir = join(tmp, 'docker-config');
mkdirSync(configDir, { recursive: true });
writeFileSync(
  join(configDir, 'nod-relay.json'),
  JSON.stringify({
    token: TOKEN,
    workspace: `127.0.0.1:${WS_PORT}`,
    browser: `127.0.0.1:${BR_PORT}`,
    connectTimeoutMs: 5000,
  }),
);

const agents = [];
function startAgent(mode, port, extraEnv = {}) {
  const child = spawn(process.execPath, [AGENT], {
    env: {
      ...process.env,
      NOD_RELAY_TEST: '1',
      NOD_RELAY_MODE: mode,
      NOD_RELAY_TOKEN: TOKEN,
      NOD_RELAY_PORT: String(port),
      NOD_RELAY_WORKSPACE_ROOT: wsRoot,
      NOD_RELAY_BROWSER_BRIDGE: bridgeFixture,
      NOD_RELAY_TEST_PATH: process.env.PATH,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agents.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${mode} agent did not start`)), 10000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('listening')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[agent ${mode}] ${d}`));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${mode} agent exited early with ${code}`));
    });
  });
}

before(async () => {
  await startAgent('workspace', WS_PORT);
  await startAgent('browser', BR_PORT);
});
after(() => {
  for (const a of agents) a.kill('SIGKILL');
  rmSync(tmp, { recursive: true, force: true });
});

// Runs the real shim like the Nod server would. Returns {code, stdout, stderr}.
// With endStdin=false the caller keeps stdin open (browser-client behaviour).
function runShim(args, { input = '', endStdin = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHIM, ...args], {
      env: { ...process.env, DOCKER_CONFIG: configDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    child.stdout.on('data', (d) => (stdout = Buffer.concat([stdout, d])));
    child.stderr.on('data', (d) => (stderr = Buffer.concat([stderr, d])));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr: stderr.toString() }));
    if (input) child.stdin.write(input);
    if (endStdin) child.stdin.end();
  });
}
function runShimOpen(args, input = '') {
  const child = spawn(process.execPath, [SHIM, ...args], {
    env: { ...process.env, DOCKER_CONFIG: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = Buffer.alloc(0);
  child.stdout.on('data', (d) => (stdout = Buffer.concat([stdout, d])));
  if (input) child.stdin.write(input);
  return { child, getStdout: () => stdout };
}

const NODE = process.execPath;
const echoStdin = ['-e', 'process.stdin.pipe(process.stdout)'];

test('workspace exec pipes stdin to stdout byte for byte', async () => {
  const payload = Buffer.from([0, 1, 2, 250, 251, 10, 13, 65, 66, 67]);
  const r = await runShim(
    ['exec', '-i', '--user', 'node', '--workdir', `/workspace/${THREAD}`, 'nod-workspace', NODE, ...echoStdin],
    { input: payload },
  );
  assert.equal(r.code, 0);
  assert.deepEqual(r.stdout, payload);
});

test('workspace exec propagates the exit code and separates stderr', async () => {
  const r = await runShim([
    'exec', '-i', '--user', 'node', '--workdir', `/workspace/${THREAD}`, 'nod-workspace',
    NODE, '-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(7)',
  ]);
  assert.equal(r.code, 7);
  assert.equal(r.stdout.toString(), 'out');
  assert.match(r.stderr, /err/);
});

test('workspace exec creates and enters the thread workdir', async () => {
  const r = await runShim([
    'exec', '-i', '--user', 'node', '--workdir', `/workspace/${THREAD}`, 'nod-workspace',
    NODE, '-e', 'process.stdout.write(process.cwd())',
  ]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.toString(), join(wsRoot, THREAD));
  assert.ok(existsSync(join(wsRoot, THREAD)));
});

test('the relay token never reaches the executed command, and the env is the fixed set', async () => {
  const r = await runShim([
    'exec', '-i', '--user', 'node', '--workdir', `/workspace/${THREAD}`, 'nod-workspace',
    NODE, '-e', 'process.stdout.write(JSON.stringify(process.env))',
  ]);
  assert.equal(r.code, 0);
  const env = JSON.parse(r.stdout.toString());
  assert.ok(!('NOD_RELAY_TOKEN' in env), 'token leaked into command env');
  assert.equal(env.HOME, '/home/node');
  assert.equal(env.LANG, 'C.UTF-8');
  assert.ok(!('NOD_AUTH_TOKEN' in env) && !('DATABASE_URL' in env));
});

test('a wrong token is refused with exit 126', async () => {
  const badDir = join(tmp, 'bad-config');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(
    join(badDir, 'nod-relay.json'),
    JSON.stringify({ token: 'wrong-token-wrong-token-wrong-token-000', workspace: `127.0.0.1:${WS_PORT}`, browser: `127.0.0.1:${BR_PORT}` }),
  );
  const child = spawn(process.execPath, [SHIM, 'exec', '-i', '--user', 'node', '--workdir', `/workspace/${THREAD}`, 'nod-workspace', NODE, ...echoStdin], {
    env: { ...process.env, DOCKER_CONFIG: badDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((resolve) => child.on('close', resolve));
  child.stdin.end();
  assert.equal(code, 126);
  assert.match(stderr, /refused: bad token/);
});

test('a workdir outside the workspace is refused', async () => {
  const r = await runShim([
    'exec', '-i', '--user', 'node', '--workdir', '/etc', 'nod-workspace', NODE, ...echoStdin,
  ]);
  assert.equal(r.code, 126);
  assert.match(r.stderr, /refused/);
});

test('node may run in /var/tmp (process-stop check shape)', async () => {
  const r = await runShim(
    ['exec', '-i', '--user', 'node', '--workdir', '/var/tmp', 'nod-workspace', NODE, ...echoStdin],
    { input: 'tmp-ok' },
  );
  assert.equal(r.code, 0);
  assert.equal(r.stdout.toString(), 'tmp-ok');
});

test('connected-CLI users run in /var/tmp but not in a thread workdir', async () => {
  const ok = await runShim(
    ['exec', '-i', '--user', '20001:1002', '--workdir', '/var/tmp', 'nod-workspace', NODE, ...echoStdin],
    { input: 'cli-ok' },
  );
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.toString(), 'cli-ok');
  const refused = await runShim([
    'exec', '-i', '--user', '20001:1002', '--workdir', `/workspace/${THREAD}`, 'nod-workspace', NODE, ...echoStdin,
  ]);
  assert.equal(refused.code, 126);
});

test('an out-of-range connected-CLI uid is refused', async () => {
  const r = await runShim([
    'exec', '-i', '--user', '60001:1002', '--workdir', '/var/tmp', 'nod-workspace', NODE, ...echoStdin,
  ]);
  assert.equal(r.code, 126);
});

test('browser exec runs the bridge and echoes stdin', async () => {
  const r = await runShim(['exec', '-i', '--user', 'node', 'nod-browser', 'node', '/app/bridge.mjs'], {
    input: 'bridge-hello',
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.toString(), 'bridge-hello');
});

test('browser exec refuses any other command or user', async () => {
  const badCmd = await runShim(['exec', '-i', '--user', 'node', 'nod-browser', 'node', '/etc/passwd']);
  assert.equal(badCmd.code, 126);
  const badUser = await runShim(['exec', '-i', '--user', 'root', 'nod-browser', 'node', '/app/bridge.mjs']);
  assert.equal(badUser.code, 126);
});

test('the shim exits when the command exits even if its stdin stays open', async () => {
  const { child } = runShimOpen([
    'exec', '-i', '--user', 'node', '--workdir', `/workspace/${THREAD}`, 'nod-workspace',
    NODE, '-e', 'process.exit(3)',
  ]);
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 3);
  child.stdin.end();
});

test('the shim rejects non-exec commands and unknown containers with 125', async () => {
  const r1 = await runShim(['ps']);
  assert.equal(r1.code, 125);
  const r2 = await runShim(['exec', '-i', '--user', 'node', 'some-other-container', NODE, ...echoStdin]);
  assert.equal(r2.code, 125);
});

test('workspace commands run as uid 1000 with root groups cleared', { skip: process.getuid?.() !== 0 }, async () => {
  const r = await runShim([
    'exec', '-i', '--user', 'node', '--workdir', `/workspace/${THREAD}`, 'nod-workspace',
    NODE, '-e', 'process.stdout.write(JSON.stringify({uid: process.getuid(), gid: process.getgid(), groups: process.getgroups()}))',
  ]);
  assert.equal(r.code, 0);
  const id = JSON.parse(r.stdout.toString());
  assert.equal(id.uid, 1000);
  assert.equal(id.gid, 1000);
  assert.ok(!id.groups.includes(0), `root group leaked: ${JSON.stringify(id.groups)}`);
});
