# Review Loop Action

Start a PR review loop with one step. The service reviews the entire PR, fixes
permitted findings, verifies the changes and re-reviews, then approves the current
revision or explains what needs a human. Approval never merges.

Save this workflow as `.github/workflows/review-loop.yml`:

```yaml
name: Request Review Loop
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  id-token: write
jobs:
  dispatch:
    if: ${{ !github.event.pull_request.draft && github.event.pull_request.head.repo.full_name == github.repository }}
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - uses: managoat/review-loop-action@v1
        with:
          service-url: ${{ vars.REVIEW_LOOP_URL }}
```

Set the repository variable `REVIEW_LOOP_URL` to your Review Loop service's HTTPS
origin. Install the [Managoat Review Loop GitHub App](https://github.com/apps/managoat-review-loop)
for the repository and merge your `.github/review-loop.yml` policy, its instruction
files and the dispatch workflow into the default branch before first use. Include
the coding-agent skill below as the third onboarding artifact.

The step needs no checkout, GitHub token input, API key or repository secret. It
uses GitHub's short-lived OIDC credential. The service validates the repository,
installation, PR, revision and trusted workflow before admitting a run. A PR that
changes its dispatch workflow cannot authorize itself. Drafts and fork PRs are
excluded by the example above.

## Repository skill

Copy [skills/review-loop/SKILL.md](skills/review-loop/SKILL.md) into
`review-loop/SKILL.md` under your coding agent's repository skill directory, then
commit it. For agents without skill discovery, reference that file from their
repository instructions. Use a reviewed commit when downloading, and review
updates before replacing your copy.

The skill explains bot commits, complete source/test repairs, current-revision
approval, human decisions, cancellation and bounded retries. It asks agents to
report outcomes briefly. It is contributor guidance; the approved-base policy
and service still enforce permissions. Installing it grants no extra authority.

## Inputs and outputs

| Name | Purpose |
|---|---|
| Input `service-url` | Required HTTPS origin, with no path, credentials, query or fragment |
| Output `run-id` | Durable Review Loop run ID |
| Output `run-url` | Link to the run and its evidence |

A green dispatch step means the service accepted the run. Follow the separate
**Review Loop** check for approval, fixes, or a human decision. The step exits
after acknowledgment; it does not wait for reviewers to finish or merge the PR.
Rejected requests and invalid acknowledgments fail the step.

## Versions and maintenance

`v1` follows compatible releases; `v1.0.0` selects the first release. For a trusted
production workflow, pin the full commit SHA shown on the release instead of a
moving tag. Changing that pin requires a reviewed workflow update in the base
branch before it can authorize a new run.

The Action runs on GitHub's Node.js 24 runtime and has no package dependencies or
build step. Its complete runtime is `index.cjs`. Run `node --test index.test.cjs`
to check credential boundaries, failure behavior and runner outputs. Tests use
local fixtures and never start a paid review loop.

MIT licensed. This public repository distributes the dispatch Action and repository
skill; the Review Loop service is operated separately.
