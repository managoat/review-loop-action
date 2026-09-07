const { appendFileSync } = require('node:fs');

const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
const clock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};
const unacknowledged = status => new Error(`Review Loop did not acknowledge dispatch${status ? ` (${status})` : ''}; a run may already exist. Check the PR's Review Loop check and current workflow/revision before retrying`);

function retryDelay(response, fallback, timer) {
  const value = response?.headers.get('retry-after');
  if (!value) return fallback;
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - timer.wallNow();
  return Number.isNaN(delay) ? fallback : Math.max(fallback, delay);
}

// One workflow attempt retains one OIDC admission identity, including after a
// lost acknowledgment. Never ask for a fresh run generation during recovery.
async function admit(service, credential, fetchImpl, timer) {
  const deadline = timer.now() + 90000;
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - timer.now();
    if (remaining <= 0) throw unacknowledged();
    let response;
    try {
      response = await fetchImpl(`${service.origin}/api/dispatch`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(Math.ceil(Math.min(30000, remaining))), redirect: 'error' });
    } catch {
      // Fetch errors may contain credentials or an untrusted response. Report
      // only our fixed diagnostic after bounded transport recovery.
    }
    if (response?.status === 202) {
      let result;
      try { result = await response.json(); } catch { throw new Error('Review Loop returned an invalid acknowledgment; check the PR for an admitted run'); }
      if (result?.accepted !== true || typeof result.id !== 'string' || !/^[a-f0-9-]{36}$/.test(result.id) || result.url !== `${service.origin}/runs/${result.id}`) throw new Error('Review Loop returned an invalid acknowledgment; check the PR for an admitted run');
      return { id: result.id, url: result.url };
    }
    if (response?.body) await response.body.cancel().catch(() => {});
    if (attempt === 2 || (response && !transientStatuses.has(response.status))) throw unacknowledged(response?.status);
    const delay = retryDelay(response, attempt === 0 ? 5000 : 15000, timer);
    // Never shorten Retry-After to fit our deadline or outlive the dispatch job.
    if (delay >= deadline - timer.now()) throw unacknowledged(response?.status);
    await timer.sleep(delay);
  }
}

/** No checkout, repository credential or provider key is needed by this Action. */
async function dispatch(env = process.env, fetchImpl = fetch, timer = clock) {
  const service = new URL(env.INPUT_SERVICE_URL || env['INPUT_SERVICE-URL'] || '');
  if (service.protocol !== 'https:' || service.username || service.password || service.search || service.hash || !['', '/'].includes(service.pathname)) throw new Error('service-url must be an HTTPS origin');
  if (env.GITHUB_EVENT_NAME !== 'pull_request') throw new Error('Review Loop dispatch requires a pull_request event');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('Grant id-token: write to the dispatch job');
  const endpoint = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (endpoint.protocol !== 'https:') throw new Error('Invalid GitHub OIDC endpoint');
  endpoint.searchParams.set('audience', service.origin);
  let issued;
  try { issued = await fetchImpl(endpoint, { headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(15000), redirect: 'error' }); }
  catch { throw new Error('GitHub could not issue the dispatch credential'); }
  if (!issued.ok) throw new Error(`GitHub could not issue the dispatch credential (${issued.status})`);
  let value;
  try { ({ value } = await issued.json()); } catch { throw new Error('GitHub returned an invalid dispatch credential'); }
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value) || value.length > 20000) throw new Error('GitHub returned an invalid dispatch credential');
  return admit(service, value, fetchImpl, timer);
}
async function main() {
  const result = await dispatch();
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run-id=${result.id}\nrun-url=${result.url}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Review Loop [accepted this run](${result.url}). This dispatch job does not approve the PR. Follow the separate **Review Loop** check.\n`);
  console.log(`Review Loop accepted ${result.id}. Approval is reported by the separate Review Loop check.`);
}
module.exports = { dispatch, main };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
