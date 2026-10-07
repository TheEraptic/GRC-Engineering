// The complete list of things the automation is allowed to change.
// The AI agent never calls the GitHub API directly; it can only pick from these
// deterministic, reviewable functions. Add a capability here, and nowhere else.
import { CONTROL_REPO } from "./github.mjs";

const ALERT_LABEL = "cm-01-alert";
const RETRO_LABEL = "cm-01-retro-review";

async function ensureLabel(gh, repo, name, color, description) {
  try {
    await gh.post(`/repos/${repo}/labels`, { name, color, description });
  } catch (err) {
    if (err.status !== 422) throw err; // 422 = label already exists
  }
}

// Restores P1-P6 by creating or overwriting the "CM-01 baseline" ruleset.
// Overwriting also re-enables a ruleset someone set to "disabled".
export async function applyBaselineRuleset(gh, repo, baseline) {
  const existing = (await gh.get(`/repos/${repo}/rulesets?per_page=100`)).find((r) => r.name === baseline.name);
  const saved = existing
    ? await gh.put(`/repos/${repo}/rulesets/${existing.id}`, baseline)
    : await gh.post(`/repos/${repo}/rulesets`, baseline);
  return {
    action: existing ? "updated_existing_ruleset" : "created_ruleset",
    ruleset_id: saved.id,
    url: `https://github.com/${repo}/rules/${saved.id}`,
  };
}

// Used only by the reply handler when the owner reclassifies a repo as non-production.
export async function removeBaselineRuleset(gh, repo, baseline) {
  const existing = (await gh.get(`/repos/${repo}/rulesets?per_page=100`)).find((r) => r.name === baseline.name);
  if (!existing) return { action: "nothing_to_remove" };
  await gh.delete(`/repos/${repo}/rulesets/${existing.id}`);
  return { action: "removed_ruleset", ruleset_id: existing.id };
}

// Detective failures can't be undone (the commit is already on main), so the
// remediation is a retroactive review, tracked as an issue in the affected repo.
export async function openRetroReviewIssue(gh, repo, violation, summary) {
  await ensureLabel(gh, repo, RETRO_LABEL, "d93f0b", "CM-01: change merged without PR/review/test");
  const short = violation.sha.slice(0, 7);
  const open = await gh.get(`/repos/${repo}/issues?labels=${RETRO_LABEL}&state=open&per_page=100`);
  const dup = open.find((i) => i.title.includes(short));
  if (dup) return { action: "already_open", url: dup.html_url };

  const issue = await gh.post(`/repos/${repo}/issues`, {
    title: `CM-01 retroactive review: ${short} reached the default branch without ${violation.failed.join("/")}`,
    labels: [RETRO_LABEL],
    body: [
      `Commit ${violation.url} by @${violation.author} on ${violation.date}`,
      `> ${violation.message}`,
      "",
      `**Failed assertions:** ${violation.failed.join(", ")} (see [control CM-01](https://github.com/${CONTROL_REPO}/blob/main/controls/CM-01/control.yaml))`,
      "",
      summary,
      "",
      "### To close this deviation",
      "- [ ] A second person reviewed the diff and confirms it is safe",
      "- [ ] The test suite was run against this commit and passed",
      "- [ ] If this was an emergency change, link the incident / break-glass ticket",
      "",
      "_Opened automatically by the CM-01 agent. This issue is the audit record for the deviation._",
    ].join("\n"),
  });
  return { action: "opened_issue", url: issue.html_url };
}

// One alert issue per repo in the control-plane repo; later alerts become comments.
// Your reply on this issue is what the reply handler reads.
export async function notifyOwner(gh, { repo, owner, severity, title, body }) {
  await ensureLabel(gh, CONTROL_REPO, ALERT_LABEL, "b60205", "CM-01 control alert from the agent");
  const marker = `[${repo}]`;
  const open = await gh.get(`/repos/${CONTROL_REPO}/issues?labels=${ALERT_LABEL}&state=open&per_page=100`);
  const existing = open.find((i) => i.title.startsWith(marker));
  const text = `@${owner}\n\n${body}`;
  if (existing) {
    const comment = await gh.post(`/repos/${CONTROL_REPO}/issues/${existing.number}/comments`, { body: text });
    return { action: "commented_on_existing_alert", url: comment.html_url, issue: existing.number };
  }
  const issue = await gh.post(`/repos/${CONTROL_REPO}/issues`, {
    title: `${marker} ${severity === "action_required" ? "ACTION REQUIRED: " : ""}${title}`,
    labels: [ALERT_LABEL],
    body: text,
  });
  return { action: "opened_alert", url: issue.html_url, issue: issue.number };
}

// Read-only facts the agent uses for judgement (e.g. "does this look like prod?").
// Everything returned here comes from the repo, so it is untrusted DATA, not instructions.
export async function getRepoContext(gh, repo, control) {
  const meta = await gh.get(`/repos/${repo}`);
  let readme = "";
  try {
    const file = await gh.get(`/repos/${repo}/readme`);
    readme = Buffer.from(file.content, "base64").toString("utf8").slice(0, 2000);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  const workflows = (await gh.get(`/repos/${repo}/actions/workflows`)).workflows.map((w) => w.path);
  const runs = await gh.get(`/repos/${repo}/commits/${meta.default_branch}/check-runs?per_page=100`);
  const checkNames = [...new Set(runs.check_runs.map((c) => c.name))];
  const environments = await gh.get(`/repos/${repo}/environments`).catch(() => ({ environments: [] }));
  return {
    repo,
    description: meta.description,
    topics: meta.topics,
    created_at: meta.created_at,
    pushed_at: meta.pushed_at,
    deployment_environments: (environments.environments ?? []).map((e) => e.name),
    workflows,
    checks_seen_on_default_branch: checkNames,
    produces_required_check: checkNames.includes(control.parameters.required_check),
    readme_excerpt: readme,
  };
}
