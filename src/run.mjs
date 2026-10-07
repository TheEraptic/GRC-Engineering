// CM-01 monitor: discover -> scope -> test -> (agent remediates) -> re-test -> document.
//   node src/run.mjs              full loop
//   node src/run.mjs --no-agent   detection + evidence only (no AI, no changes)
import { runAgent } from "./agent.mjs";
import { evaluateRepo } from "./checks.mjs";
import { loadBaseline, loadControl, loadExceptions, loadInventory, scopeFor } from "./config.mjs";
import { writeEvidence, writeStatus } from "./evidence.mjs";
import { clients } from "./github.mjs";

const noAgent = process.argv.includes("--no-agent");
const control = loadControl();
const inventory = loadInventory();
const exceptions = loadExceptions();
const { admin, bot } = clients();

const record = {
  control: control.id,
  run_id: process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`,
  trigger: process.env.GRC_TRIGGER ?? "manual",
  started_at: new Date().toISOString(),
  repos: [],
};

// 1. Discover: only repos the owner opted in with the topic (lab safety).
const owned = await admin.get(`/user/repos?affiliation=owner&per_page=100`);
const monitored = owned
  .filter((r) => r.owner.login === control.owner && r.topics?.includes(control.scope.discovery_topic))
  .map((r) => r.full_name)
  .sort();
console.log(`${control.id}: ${monitored.length} monitored repo(s): ${monitored.join(", ")}`);

// 2-3. Scope and test.
for (const repo of monitored) {
  const scope = scopeFor(repo, control, inventory, exceptions);
  const entry = { repo, scope, evaluation: null };
  if (scope.status === "in_scope") entry.evaluation = await evaluateRepo(admin, repo, control, inventory[repo]);
  record.repos.push(entry);
  const e = entry.evaluation;
  console.log(`  ${repo}: ${scope.status}${e ? ` -> ${e.status}${e.failures.length ? ` [${e.failures.join(", ")}]` : ""}` : ""}`);
}

// 4. Hand failures to the agent.
const failing = record.repos
  .filter((r) => r.evaluation?.status === "FAIL")
  .map((r) => ({ ...r.evaluation, scope: r.scope }));

if (failing.length === 0) {
  record.agent = { skipped: "No failures: nothing to remediate (no AI call made)" };
} else if (noAgent) {
  record.agent = { skipped: "--no-agent: detection only" };
} else if (!process.env.ANTHROPIC_API_KEY) {
  record.agent = { skipped: "ANTHROPIC_API_KEY not set: failures detected and documented, not remediated" };
} else {
  console.log(`Agent: remediating ${failing.length} repo(s)...`);
  record.agent = await runAgent({ failing, control, baseline: loadBaseline(control), gh: admin, ghBot: bot, inventory });

  // 5. Re-test independently. The evidence of "fixed" comes from the checks, not from the AI's word.
  for (const r of record.repos.filter((x) => x.evaluation?.status === "FAIL")) {
    r.after_remediation = await evaluateRepo(admin, r.repo, control, inventory[r.repo], { preventiveOnly: true });
  }
}
if (record.agent.skipped) console.log(`Agent: ${record.agent.skipped}`);

// 6. Document.
record.finished_at = new Date().toISOString();
writeEvidence(record);
writeStatus(record, control);
console.log(`Evidence: ${record.evidence_file}\nStatus:   CONTROL-STATUS.md`);
