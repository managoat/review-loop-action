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
