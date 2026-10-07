// Deterministic control tests for CM-01. No AI here: the same inputs always give
// the same pass/fail, which is what makes the results usable as audit evidence.

const result = (pass, detail) => ({ pass, detail });

// P1-P6: is the guardrail configured right now?
export async function preventiveChecks(gh, repo, branch, control) {
  const { min_approvals, required_check, allowed_bypass_actors } = control.parameters;

  // "Effective rules" = what GitHub actually enforces on this branch from all
  // *active* rulesets. A disabled or evaluate-only ruleset contributes nothing.
  const rules = await gh.get(`/repos/${repo}/rules/branches/${encodeURIComponent(branch)}`);
  const ofType = (type) => rules.filter((r) => r.type === type);
  const prRules = ofType("pull_request").map((r) => r.parameters);
  const checks = ofType("required_status_checks").flatMap((r) =>
    r.parameters.required_status_checks.map((c) => c.context),
  );

  const rulesetIds = [...new Set(rules.map((r) => r.ruleset_id))];
  const bypassers = [];
  for (const id of rulesetIds) {
    const rs = await gh.get(`/repos/${repo}/rulesets/${id}`);
    for (const actor of rs.bypass_actors ?? []) {
      const allowed = allowed_bypass_actors.some(
        (a) => a.actor_id === actor.actor_id && a.actor_type === actor.actor_type,
      );
      if (!allowed) bypassers.push(`${actor.actor_type}:${actor.actor_id ?? "*"} on '${rs.name}'`);
    }
  }

  const maxApprovals = Math.max(0, ...prRules.map((p) => p.required_approving_review_count));
  return {
    P1: result(prRules.length > 0, prRules.length ? "Pull request required" : "No active rule requires a pull request"),
    P2: result(maxApprovals >= min_approvals, `${maxApprovals} approval(s) required (need >= ${min_approvals})`),
    P3: result(prRules.some((p) => p.dismiss_stale_reviews_on_push), prRules.some((p) => p.dismiss_stale_reviews_on_push) ? "Stale approvals dismissed" : "Stale approvals are NOT dismissed on push"),
    P4: result(checks.includes(required_check), checks.length ? `Required checks: ${checks.join(", ")}` : `'${required_check}' check is not required`),
    P5: rulesetIds.length === 0
      ? result(false, "No active ruleset protects the branch")
      : result(bypassers.length === 0, bypassers.length ? `Bypass allowed for ${bypassers.join("; ")}` : "No bypass actors"),
    P6: result(
      ofType("non_fast_forward").length > 0 && ofType("deletion").length > 0,
      `force-push ${ofType("non_fast_forward").length ? "blocked" : "ALLOWED"}, deletion ${ofType("deletion").length ? "blocked" : "ALLOWED"}`,
    ),
  };
}

// D1-D3: did every change in the period actually follow the control?
// Settings can be correct today while someone bypassed them on Tuesday,
// so the population of commits is tested, not just the configuration.
export async function detectiveChecks(gh, repo, branch, control, since) {
  const { required_check } = control.parameters;
  // Lab simplification: one page (100 commits) per run. Production code would paginate.
  const commits = await gh.get(
    `/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${since.toISOString()}&per_page=100`,
  );

  const prCache = new Map();
  async function assessPr(pr) {
    if (prCache.has(pr.number)) return prCache.get(pr.number);
    const reviews = await gh.get(`/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`);
    const approvedByOther = reviews.some(
      (r) => r.state === "APPROVED" && r.user?.login !== pr.user.login && r.commit_id === pr.head.sha,
    );
    const runs = await gh.get(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`);
    const testPassed = runs.check_runs.some((c) => c.name === required_check && c.conclusion === "success");
    const assessment = { approvedByOther, testPassed };
    prCache.set(pr.number, assessment);
    return assessment;
  }

  const violations = [];
  for (const c of commits) {
    const pulls = await gh.get(`/repos/${repo}/commits/${c.sha}/pulls`);
    const merged = pulls.find((p) => p.merged_at && p.base.ref === branch);
    const base = {
      sha: c.sha,
      message: c.commit.message.split("\n")[0],
      author: c.author?.login ?? c.commit.author.name,
      date: c.commit.committer.date,
      url: c.html_url,
    };
    if (!merged) {
      violations.push({ ...base, pr: null, failed: ["D1"] });
      continue;
    }
    const { approvedByOther, testPassed } = await assessPr(merged);
    const failed = [...(approvedByOther ? [] : ["D2"]), ...(testPassed ? [] : ["D3"])];
    if (failed.length) violations.push({ ...base, pr: merged.number, failed });
  }

  const offenders = (id) => violations.filter((v) => v.failed.includes(id)).map((v) => v.sha.slice(0, 7));
  const summarize = (id, ok, bad) => {
    const list = offenders(id);
    return result(list.length === 0, list.length ? `${bad}: ${list.join(", ")}` : ok);
  };
  return {
    period: { since: since.toISOString(), commits_tested: commits.length },
    results: {
      D1: summarize("D1", `All ${commits.length} commit(s) came from merged PRs`, "Commits pushed without a PR"),
      D2: summarize("D2", "All PRs approved by a non-author on the final commit", "PRs merged without independent approval"),
      D3: summarize("D3", `'${required_check}' passed on every merged PR`, `PRs merged without a passing '${required_check}'`),
    },
    violations,
  };
}

export async function evaluateRepo(gh, repo, control, inventoryEntry, { preventiveOnly = false } = {}) {
  const meta = await gh.get(`/repos/${repo}`);
  const branch = meta.default_branch;
  const preventive = await preventiveChecks(gh, repo, branch, control);

  let detective = null;
  if (!preventiveOnly) {
    const lookback = new Date(Date.now() - control.parameters.detective_lookback_days * 864e5);
    const starts = [lookback, new Date(control.effective_date)];
    if (inventoryEntry?.in_scope_since) starts.push(new Date(inventoryEntry.in_scope_since));
    const since = new Date(Math.max(...starts));
    detective = await detectiveChecks(gh, repo, branch, control, since);
  }

  const results = { ...preventive, ...(detective?.results ?? {}) };
  const failures = Object.entries(results).filter(([, r]) => !r.pass).map(([id]) => id);
  return {
    repo,
    default_branch: branch,
    status: failures.length ? "FAIL" : "PASS",
    failures,
    results,
    period: detective?.period ?? null,
    violations: detective?.violations ?? [],
  };
}
