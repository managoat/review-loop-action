const { appendFileSync } = require('node:fs');

/** No checkout, repository credential or provider key is needed by this Action. */
async function dispatch(env = process.env, fetchImpl = fetch) {
  const service = new URL(env.INPUT_SERVICE_URL || env['INPUT_SERVICE-URL'] || '');
  if (service.protocol !== 'https:' || service.username || service.password || service.search || service.hash || !['', '/'].includes(service.pathname)) throw new Error('service-url must be an HTTPS origin');
  if (env.GITHUB_EVENT_NAME !== 'pull_request') throw new Error('Review Loop dispatch requires a pull_request event');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('Grant id-token: write to the dispatch job');
  const endpoint = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (endpoint.protocol !== 'https:') throw new Error('Invalid GitHub OIDC endpoint');
  endpoint.searchParams.set('audience', service.origin);
  const issued = await fetchImpl(endpoint, { headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!issued.ok) throw new Error(`GitHub could not issue the dispatch credential (${issued.status})`);
  const { value } = await issued.json();
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value) || value.length > 20000) throw new Error('GitHub returned an invalid dispatch credential');
  const response = await fetchImpl(`${service.origin}/api/dispatch`, { method: 'POST', headers: { authorization: `Bearer ${value}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (response.status !== 202) throw new Error(`Review Loop did not acknowledge dispatch (${response.status}); inspect the dispatch configuration or sign in to start the PR manually`);
  const result = await response.json();
  if (result.accepted !== true || typeof result.id !== 'string' || !/^[a-f0-9-]{36}$/.test(result.id) || result.url !== `${service.origin}/runs/${result.id}`) throw new Error('Review Loop returned an invalid acknowledgment');
  return { id: result.id, url: result.url };
}
async function main() {
  const result = await dispatch();
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run-id=${result.id}\nrun-url=${result.url}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Review Loop [accepted this run](${result.url}). This dispatch job does not approve the PR. Follow the separate **Review Loop** check.\n`);
  console.log(`Review Loop accepted ${result.id}. Approval is reported by the separate Review Loop check.`);
}
module.exports = { dispatch, main };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
