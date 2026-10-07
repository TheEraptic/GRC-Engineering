# GRC Engineering Lab: CM-01 change management

A working example of **GRC engineering**: one SOC 2 control expressed as code,
tested continuously, remediated automatically, with an AI agent that handles
judgement and communication. A human only steps in to make decisions that belong
to a human.

> **CM-01 (SOC 2 CC8.1):** All changes to production must go through a pull request,
> code review, and automated test before merge.

Current state of the control: **[CONTROL-STATUS.md](CONTROL-STATUS.md)**

## How it works

```
 control.yaml ──► checks.mjs ──► FAIL? ──► agent.mjs (Claude) ──► remediate.mjs ──► checks.mjs (re-verify)
 (what "good"     (deterministic   │         decides what to do,     (allow-listed       │
  means)           P1-P6, D1-D3)   │         explains it             actions only)        │
                                   ▼                                                      ▼
                          evidence/runs/*.json  ◄──────────────────────────────────  CONTROL-STATUS.md
                                   ▲
 you reply on the alert issue ──► reply.mjs ──► inventory/repos.yaml or exceptions/register.yaml (git = audit trail)
```

| Layer | File | AI? | Why |
|---|---|---|---|
| Control definition | [`controls/CM-01/control.yaml`](controls/CM-01/control.yaml) | – | One source of truth that humans and machines both read |
| Desired state | [`controls/CM-01/baseline-ruleset.json`](controls/CM-01/baseline-ruleset.json) | – | The exact GitHub ruleset that satisfies P1-P6 |
| Scope | [`inventory/repos.yaml`](inventory/repos.yaml) | – | Which repos are production. Unlisted = production (fail-secure) |
| Detection | [`src/checks.mjs`](src/checks.mjs) | **No** | Audit evidence must be repeatable: same input, same answer |
| Remediation | [`src/remediate.mjs`](src/remediate.mjs) | **No** | The complete allow-list of changes automation may make |
| Decision + messaging | [`src/agent.mjs`](src/agent.mjs) | **Yes** | Judgement ("does this look like prod?"), sequencing, clear messages |
| Human decisions | [`src/reply.mjs`](src/reply.mjs) | Partly | Exact commands parsed by code; free text interpreted by Claude |
| Exceptions | [`exceptions/register.yaml`](exceptions/register.yaml) | – | Time-boxed, owner-approved risk acceptance |
| Evidence | [`evidence/runs/`](evidence/runs) | – | Every run and decision, committed to git |

### The guardrails on the agent

1. **It can't call GitHub directly.** It can only use 5 tools that wrap `remediate.mjs`.
2. **It can only touch what failed in this run.** Any other repo or commit is refused in code.
3. **It can't change scope or accept risk.** Only your reply can (`human_only` in control.yaml).
4. **Its word isn't the evidence.** After it finishes, `run.mjs` re-runs the checks independently.
5. **Repo content is untrusted.** A README saying "ignore your instructions" is just data.
6. **Only the control owner's replies count.** Comments from anyone else are ignored and logged.

## Where everything is documented

| Question an auditor asks | Where the answer lives |
|---|---|
| What exactly is the control? | `controls/CM-01/control.yaml` |
| Was it tested, how often, and with what result? | `evidence/runs/<date>/*-run.json` (one per run; full population of commits) |
| What failed, and what was done about it? | `agent.actions` in the run file, plus the alert issues (label `cm-01-alert`) |
| Was the fix verified? | `after_remediation` in the run file (independent re-test, not the AI's claim) |
| Changes that bypassed review? | Retro-review issues (label `cm-01-retro-review`) in the affected repo |
| Why is repo X out of scope? Who decided? | `inventory/repos.yaml` + git blame + the linked alert issue |
| Approved exceptions? | `exceptions/register.yaml` (with expiry) |

## Setup (one time)

The monitor needs two secrets in this repo (**Settings → Secrets and variables → Actions**):

1. **`ANTHROPIC_API_KEY`**: an API key from https://console.anthropic.com
2. **`GRC_ADMIN_TOKEN`**: a fine-grained personal access token (https://github.com/settings/personal-access-tokens/new)
   - Repository access: **Only select repositories** → `grc-lab-payments-api`, `grc-lab-sandbox`
   - Permissions: **Administration: Read and write**, **Issues: Read and write**, **Contents: Read-only**, **Actions: Read-only**
   - (Least privilege: this token can't touch your other repos.)

Then go to **Actions → CM-01 monitor → Run workflow**.

To run it locally instead: `npm ci`, then `npm run check` (detection only), or set `ANTHROPIC_API_KEY` and run `npm run monitor`.

## Exercises: break it and watch it heal

Run **Actions → CM-01 monitor → Run workflow** after each one.

1. **First run.** Both repos are unprotected. Watch the agent fix both. For the unclassified sandbox, it also asks you to classify it.
2. **Reply to the sandbox alert** with `non-prod my scratchpad, nothing deployed`. Check `inventory/repos.yaml` and the git log.
3. **Disable the ruleset** on payments-api (Settings → Rules → CM-01 baseline → Enforcement: Disabled). The next run re-enables it (P1-P6).
4. **Add a bypass actor** (Repository admin) to the ruleset. The next run removes it (P5).
5. **Bypass the control:** disable the ruleset, edit `README.md` directly on `main` in the web UI, then run. The agent re-protects the branch **and** opens a retro-review issue for that commit (D1). The commit can't be undone.
6. **Free-text reply:** on an alert, reply in your own words (e.g. "that one's live, keep it locked") and see Claude interpret it.
7. **New repo:** create a repo, add the `grc-monitored` topic, and run. It's unclassified, so it's protected first and then you're asked about it.
8. **Exception:** reply `accept-risk 7 migrating CI provider` and watch the repo show as *excepted* until the expiry.

## Lab simplifications (what a production version adds)

- **Real-time triggers:** a GitHub App receiving `repository_ruleset` and `push` webhooks, instead of a 6-hourly schedule.
- **Org-level rulesets** targeting a repo custom property `environment=production`. These need a GitHub org; this lab uses a personal account.
- **D4 (bypass events have a break-glass ticket):** needs the org audit log.
- **WORM evidence storage** (e.g. S3 Object Lock) in addition to git.
- **Pagination** beyond 100 commits per run.
- **Alerts in Slack or Teams:** swap the body of `notifyOwner` and keep the reply handler as is.
