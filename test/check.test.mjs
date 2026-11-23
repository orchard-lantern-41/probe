import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check.sh');
const TOKEN = '123456:TESTTOKEN';
const CHAT = '-100999';

let server, base, host;
let tg = []; // received notifications
let pings = 0;
let tgStatus = 200;
let flakyCount = 0;
let mode = { toggle: 200 };
const hung = new Set();

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/ok') return res.end('ok');
    if (req.url === '/err') { res.statusCode = 500; return res.end('boom'); }
    if (req.url === '/hang') { hung.add(res); return; }
    if (req.url === '/toggle') { res.statusCode = mode.toggle; return res.end('x'); }
    if (req.url === '/flaky') { res.statusCode = flakyCount++ === 0 ? 500 : 200; return res.end('x'); }
    if (req.url === '/ping') { pings++; return res.end('ok'); }
    if (req.url.startsWith(`/bot${TOKEN}/sendMessage`)) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (tgStatus === 200) tg.push(Object.fromEntries(new URLSearchParams(body)));
        res.statusCode = tgStatus;
        res.end('{}');
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  host = '127.0.0.1';
  base = `http://${host}:${port}`;
});
after(() => {
  for (const r of hung) r.destroy();
  server.closeAllConnections();
  server.close();
});

function run(env, dir) {
  const state = join(dir, 'state.txt');
  const out = join(dir, 'gh-output.txt');
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT], {
      env: {
        PATH: process.env.PATH,
        ATTEMPTS: '2', WAIT: '0', TIMEOUT: '1', TG_WAIT: '0',
        STATE: state, GITHUB_OUTPUT: out, TG_API: base,
        ...env,
      },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({
      code, stdout, stderr, all: stdout + stderr,
      state: existsSync(state) ? readFileSync(state, 'utf8') : '',
      output: existsSync(out) ? readFileSync(out, 'utf8') : '',
    }));
  });
}
const tmp = () => mkdtempSync(join(tmpdir(), 'probe-'));
const creds = { TG_TOKEN: TOKEN, TG_CHAT: CHAT };
const visible = (s) => s.split('\n').filter((l) => !l.startsWith('::add-mask::')).join('\n');

test('200, 500 and a hung server: up, down, down', async () => {
  const r = await run({ LIST_A: `a1|${base}/ok\na2|${base}/err\na3|${base}/hang` }, tmp());
  assert.equal(r.code, 0);
  assert.match(r.state, /^a1=up$/m);
  assert.match(r.state, /^a2=down$/m);
  assert.match(r.state, /^a3=down$/m);
  assert.match(r.stdout, /\[a2\] attempt 2\/2: fail \(500\)/);
  assert.match(r.stdout, /\[a3\] attempt 2\/2: fail \(000\)/);
});

test('dry run without token prints only label and state', async () => {
  const r = await run({ LIST_A: `d1|${base}/err` }, tmp());
  assert.equal(r.code, 0);
  assert.match(r.stdout, /dry-run: d1 -> down/);
  assert.ok(!visible(r.all).includes(base), 'no address in the output');
  assert.equal(tg.length, 0);
});

test('down -> alert -> still down -> nothing -> up -> alert -> nothing', async () => {
  tg = []; mode.toggle = 500;
  const dir = tmp();
  const env = { LIST_A: `t1|${base}/toggle`, ...creds };
  const outputs = [];
  let r = await run(env, dir); outputs.push(r.all);
  assert.equal(tg.length, 1);
  assert.match(tg[0].text, /t1 caído/);
  assert.equal(tg[0].disable_notification, 'false');
  assert.equal(tg[0].chat_id, CHAT);
  assert.equal(r.output.trim(), 'changed=true');

  r = await run(env, dir); outputs.push(r.all);
  assert.equal(tg.length, 1, 'no repeat while it stays down');
  assert.equal(r.output.trim().split('\n').pop(), 'changed=false');

  mode.toggle = 200;
  r = await run(env, dir); outputs.push(r.all);
  assert.equal(tg.length, 2);
  assert.match(tg[1].text, /t1 recuperado/);

  r = await run(env, dir); outputs.push(r.all);
  assert.equal(tg.length, 2, 'no repeat once it is back');
  assert.match(r.state, /^t1=up$/m);

  for (const o of outputs) {
    const v = visible(o);
    assert.ok(!v.includes(base) && !v.includes(host) && !v.includes('http'), 'no address in any output');
  }
});

test('one failed attempt followed by a good one is not an alert', async () => {
  tg = []; flakyCount = 0;
  const r = await run({ LIST_A: `f1|${base}/flaky`, ...creds }, tmp());
  assert.equal(tg.length, 0);
  assert.match(r.state, /^f1=up$/m);
  assert.match(r.stdout, /\[f1\] attempt 1\/2: fail \(500\)/);
  assert.match(r.stdout, /\[f1\] attempt 2\/2: ok/);
});

test('quiet hours: silent alert, one loud reminder after, then nothing', async () => {
  tg = []; mode.toggle = 500;
  const dir = tmp();
  const env = { LIST_A: `q1|${base}/toggle`, QUIET: '23-08', ...creds };
  let r = await run({ ...env, NOW_HOUR: '2' }, dir);
  assert.equal(tg.length, 1);
  assert.equal(tg[0].disable_notification, 'true');
  assert.match(r.state, /^q1=downq$/m);

  r = await run({ ...env, NOW_HOUR: '3' }, dir);
  assert.equal(tg.length, 1, 'nothing more during the quiet window');

  r = await run({ ...env, NOW_HOUR: '9' }, dir);
  assert.equal(tg.length, 2);
  assert.match(tg[1].text, /q1 sigue caído/);
  assert.equal(tg[1].disable_notification, 'false');

  r = await run({ ...env, NOW_HOUR: '10' }, dir);
  assert.equal(tg.length, 2);
  assert.match(r.state, /^q1=down$/m);
});

test('quiet window edges (23-08): 23 and 7 are quiet, 8 and 22 are not; non-wrapping window', async () => {
  const cases = [['23', '23-08', 'true'], ['7', '23-08', 'true'], ['8', '23-08', 'false'],
    ['22', '23-08', 'false'], ['13', '12-14', 'true'], ['14', '12-14', 'false'], ['3', '', 'false']];
  for (const [h, q, expected] of cases) {
    tg = []; mode.toggle = 500;
    await run({ LIST_A: `e1|${base}/toggle`, QUIET: q, NOW_HOUR: h, ...creds }, tmp());
    assert.equal(tg[0].disable_notification, expected, `hour ${h} window "${q}"`);
  }
});

test('failed notification keeps the state so the next run retries', async () => {
  tg = []; mode.toggle = 500; tgStatus = 500;
  const dir = tmp();
  const env = { LIST_A: `n1|${base}/toggle`, ...creds };
  let r = await run(env, dir);
  assert.equal(r.code, 1);
  assert.match(r.state, /^n1=up$/m);
  tgStatus = 200;
  r = await run(env, dir);
  assert.equal(r.code, 0);
  assert.equal(tg.length, 1);
  assert.match(r.state, /^n1=down$/m);
});

test('two lists, CRLF, comments and blank lines', async () => {
  const r = await run({
    LIST_A: `# c\r\nb1|${base}/ok\r\n\r\n`,
    LIST_B: `b2|${base}/err\r\n`,
  }, tmp());
  assert.equal(r.code, 0);
  assert.match(r.state, /^b1=up$/m);
  assert.match(r.state, /^b2=down$/m);
});

test('masks every address and host before any request', async () => {
  const r = await run({ LIST_A: `m1|${base}/ok` }, tmp());
  const lines = r.stdout.split('\n');
  const firstProbe = lines.findIndex((l) => l.startsWith('[m1]'));
  const masks = lines.slice(0, firstProbe).filter((l) => l.startsWith('::add-mask::'));
  const values = masks.map((l) => l.slice('::add-mask::'.length));
  assert.ok(values.includes(`${base}/ok`), 'full address masked');
  assert.ok(values.includes(host), 'host masked');
  assert.ok(values.includes(`${host}:${new URL(base).port}`), 'host:port masked');
});

test('invalid input fails without echoing it', async () => {
  const secretish = `${base}/very-private-path`;
  for (const list of [`nolabel`, `bad label|${secretish}`, `x1|ftp://${host}/p`, `x1|${base}/a\nx1|${base}/b`]) {
    const r = await run({ LIST_A: list }, tmp());
    assert.equal(r.code, 1, list);
    assert.ok(!r.all.includes('very-private-path'));
    assert.ok(!visible(r.all).includes(host));
  }
  const empty = await run({}, tmp());
  assert.equal(empty.code, 1);
  const q = await run({ LIST_A: `z|${base}/ok`, QUIET: 'night' }, tmp());
  assert.equal(q.code, 1);
});

test('optional heartbeat is requested once per run and is silent', async () => {
  pings = 0;
  const r = await run({ LIST_A: `h1|${base}/ok`, PING: `${base}/ping` }, tmp());
  assert.equal(pings, 1);
  assert.ok(!visible(r.all).includes('ping'));
});
