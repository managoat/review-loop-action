const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { dispatch } = require('./index.cjs');

const origin = 'https://review.example';
const id = 'abcdef01-1234-1234-1234-abcdef123456';
const environment = {
  'INPUT_SERVICE-URL': origin,
  GITHUB_EVENT_NAME: 'pull_request',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.github.invalid/token?api-version=2',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-test-credential',
};
const accepted = () => Response.json({ accepted: true, id, url: `${origin}/runs/${id}` }, { status: 202 });

test('uses the runner input name, requests the audience and sends only signed authority', async () => {
  const calls = [];
  const result = await dispatch(environment, async (url, init) => {
    calls.push({ url: new URL(url), init });
    return calls.length === 1 ? Response.json({ value: 'signed.oidc.token' }) : accepted();
  });
  assert.equal(calls[0].url.searchParams.get('audience'), origin);
  assert.equal(calls[0].url.searchParams.get('api-version'), '2');
  assert.equal(calls[0].init.headers.authorization, 'Bearer runner-test-credential');
  assert.equal(calls[1].url.href, `${origin}/api/dispatch`);
  assert.equal(calls[1].init.headers.authorization, 'Bearer signed.oidc.token');
  assert.equal(calls[1].init.body, '{}');
  assert(calls.every(call => call.init.redirect === 'error' && call.init.signal instanceof AbortSignal));
  assert.deepEqual(result, { id, url: `${origin}/runs/${id}` });
});

test('rejects unsafe service origins before obtaining credentials', async () => {
  for (const value of ['http://review.example', 'https://user:pass@review.example', 'https://review.example/path', 'https://review.example?x=1', 'https://review.example#fragment']) {
    await assert.rejects(dispatch({ ...environment, 'INPUT_SERVICE-URL': value }, () => assert.fail('must not fetch')), /HTTPS origin/);
  }
});

test('requires a PR event and OIDC permission before contacting the service', async () => {
  await assert.rejects(dispatch({ ...environment, GITHUB_EVENT_NAME: 'pull_request_target' }, () => assert.fail('must not fetch')), /pull_request event/);
  await assert.rejects(dispatch({ ...environment, ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }, () => assert.fail('must not fetch')), /id-token: write/);
  await assert.rejects(dispatch({ ...environment, ACTIONS_ID_TOKEN_REQUEST_URL: 'http://oidc.github.invalid' }, () => assert.fail('must not fetch')), /Invalid GitHub OIDC endpoint/);
});

test('does not dispatch when OIDC fails or returns a malformed token', async () => {
  for (const response of [new Response('', { status: 403 }), Response.json({ value: 'bad\ntoken' }), Response.json({ value: 'x'.repeat(20001) })]) {
    let calls = 0;
    await assert.rejects(dispatch(environment, async () => { assert.equal(++calls, 1); return response; }), /credential/);
    assert.equal(calls, 1);
  }
});

test('a refused dispatch or forged acknowledgment cannot report success', async () => {
  for (const response of [new Response('', { status: 403 }), acceptedWith({ accepted: false }), acceptedWith({ url: 'https://attacker.example' }), acceptedWith({ id: id + '\nforged=value' }), acceptedWith({ id: 'not-a-run' })]) {
    let calls = 0;
    await assert.rejects(dispatch(environment, async () => ++calls === 1 ? Response.json({ value: 'signed.oidc.token' }) : response), /acknowledg/);
  }
});
function acceptedWith(changes) {
  return Response.json({ accepted: true, id, url: `${origin}/runs/${id}`, ...changes }, { status: 202 });
}

function recoveryFixture(handler) {
  let elapsed = 0, issued = 0, attempts = 0;
  const sleeps = [];
  const timer = { now: () => elapsed, wallNow: () => Date.UTC(2026, 8, 7) + elapsed, async sleep(ms) { sleeps.push(ms); elapsed += ms; } };
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://oidc.github.invalid/')) {
      issued++;
      return Response.json({ value: 'signed.oidc.token' });
    }
    assert.equal(String(url), `${origin}/api/dispatch`);
    assert.equal(init.headers.authorization, 'Bearer signed.oidc.token');
    assert.equal(init.body, '{}');
    assert.equal(init.redirect, 'error');
    return handler(++attempts, init);
  };
  return { run: () => dispatch(environment, fetchImpl, timer), timer, sleeps, advance(ms) { elapsed += ms; }, get attempts() { return attempts; }, get issued() { return issued; } };
}

test('transient HTTP failures reuse one credential with bounded backoff', async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const f = recoveryFixture(attempt => attempt < 3 ? new Response('untrusted response', { status }) : accepted());
    assert.deepEqual(await f.run(), { id, url: `${origin}/runs/${id}` });
    assert.equal(f.issued, 1); assert.equal(f.attempts, 3); assert.deepEqual(f.sleeps, [5000, 15000]);
  }
});

test('lost headers and failed or aborted body streams retry with unchanged authority', async () => {
  for (const phase of ['headers', 'body-error', 'body-abort', 'body-timeout']) {
    const f = recoveryFixture(attempt => {
      if (attempt !== 1) return accepted();
      if (phase === 'headers') throw new Error('lost acknowledgment');
      const error = phase === 'body-error' ? new TypeError('signed.oidc.token') : new DOMException('signed.oidc.token', phase === 'body-abort' ? 'AbortError' : 'TimeoutError');
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"accepted":true,')); controller.error(error);
      } }), { status: 202 });
    });
    assert.deepEqual(await f.run(), { id, url: `${origin}/runs/${id}` });
    assert.equal(f.issued, 1); assert.equal(f.attempts, 2);
  }
});

test('refusals do not retry or reflect untrusted bodies', async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    const f = recoveryFixture(() => new Response('signed.oidc.token\n::error::untrusted', { status }));
    await assert.rejects(f.run(), error => {
      assert.match(error.message, /did not acknowledge/);
      assert(!error.message.includes('signed.oidc.token'));
      return true;
    });
    assert.equal(f.attempts, 1); assert.deepEqual(f.sleeps, []);
  }
});

test('persistent transport failure stops without exposing exception contents', async () => {
  const f = recoveryFixture(() => { throw new Error('signed.oidc.token'); });
  await assert.rejects(f.run(), error => {
    assert.match(error.message, /a run may already exist/);
    assert(!error.message.includes('signed.oidc.token'));
    return true;
  });
  assert.equal(f.attempts, 3);
});

test('Retry-After seconds and dates are honored without exceeding the budget', async () => {
  for (const value of ['25', 'Mon, 07 Sep 2026 00:00:25 GMT']) {
    const f = recoveryFixture(attempt => attempt === 1 ? new Response(null, { status: 503, headers: { 'retry-after': value } }) : accepted());
    await f.run(); assert.deepEqual(f.sleeps, [25000]);
  }
  const f = recoveryFixture(() => new Response(null, { status: 429, headers: { 'retry-after': '120' } }));
  await assert.rejects(f.run(), /did not acknowledge/);
  assert.equal(f.attempts, 1); assert.deepEqual(f.sleeps, []);
});

test('an elapsed deadline prevents another request', async () => {
  const f = recoveryFixture(() => new Response(null, { status: 503 }));
  f.timer.sleep = async () => f.advance(90001);
  await assert.rejects(f.run(), /did not acknowledge/); assert.equal(f.attempts, 1);
});

test('invalid acknowledgment bodies remain failures without retries', async () => {
  for (const body of ['null', '{', JSON.stringify({ accepted: true, id, url: 'https://attacker.example' })]) {
    const f = recoveryFixture(() => new Response(body, { status: 202 }));
    await assert.rejects(f.run(), /invalid acknowledgment/); assert.equal(f.attempts, 1);
  }
});

test('runner entrypoint writes outputs only after acknowledgment and never prints credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-loop-action-'));
  try {
    const preload = join(dir, 'fetch-fixture.cjs');
    writeFileSync(preload, `let calls = 0; globalThis.fetch = async () => ++calls === 1 ? Response.json({value:'signed.oidc.token'}) : Response.json({accepted:true,id:'${id}',url:'${origin}/runs/${id}'},{status:202});`);
    const output = join(dir, 'output'), summary = join(dir, 'summary');
    const result = spawnSync(process.execPath, ['--require', preload, join(__dirname, 'index.cjs')], {
      encoding: 'utf8', env: { ...environment, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), `run-id=${id}\nrun-url=${origin}/runs/${id}\n`);
    assert.match(readFileSync(summary, 'utf8'), /does not approve the PR/);
    assert(!`${result.stdout}${result.stderr}`.includes('signed.oidc.token'));
    assert(!`${result.stdout}${result.stderr}`.includes(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN));
    const rejectedOutput = join(dir, 'rejected-output');
    const rejected = spawnSync(process.execPath, [join(__dirname, 'index.cjs')], {
      encoding: 'utf8', env: { ...environment, GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: rejectedOutput },
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /pull_request event/);
    assert.equal(existsSync(rejectedOutput), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
