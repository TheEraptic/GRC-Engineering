// Loads and saves the "as code" state files: control, baseline, inventory, exceptions.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTROL_DIR = join(ROOT, "controls", "CM-01");
const INVENTORY = join(ROOT, "inventory", "repos.yaml");
const EXCEPTIONS = join(ROOT, "exceptions", "register.yaml");

export const loadControl = () => YAML.parse(readFileSync(join(CONTROL_DIR, "control.yaml"), "utf8"));

// The ruleset that remediation applies. Parameters come from control.yaml so the
// control file stays the single source of truth.
export function loadBaseline(control) {
  const ruleset = JSON.parse(readFileSync(join(CONTROL_DIR, "baseline-ruleset.json"), "utf8"));
  for (const rule of ruleset.rules) {
    if (rule.type === "pull_request") {
      rule.parameters.required_approving_review_count = control.parameters.min_approvals;
    }
    if (rule.type === "required_status_checks") {
      rule.parameters.required_status_checks = [{ context: control.parameters.required_check }];
    }
  }
  ruleset.bypass_actors = control.parameters.allowed_bypass_actors;
  return ruleset;
}

// Inventory and exceptions are edited with parseDocument so the explanatory
// comments in those files survive automated writes.
const loadDoc = (file) => YAML.parseDocument(readFileSync(file, "utf8"));
const saveDoc = (file, doc) => writeFileSync(file, doc.toString());

export const loadInventoryDoc = () => loadDoc(INVENTORY);
export const saveInventoryDoc = (doc) => saveDoc(INVENTORY, doc);
export const loadExceptionsDoc = () => loadDoc(EXCEPTIONS);
export const saveExceptionsDoc = (doc) => saveDoc(EXCEPTIONS, doc);

export const loadInventory = () => loadInventoryDoc().toJS().repos ?? {};
export const loadExceptions = () => loadExceptionsDoc().toJS().exceptions ?? [];

// Decides whether a repo is tested this run, and why. The "why" goes into evidence.
export function scopeFor(repo, control, inventory, exceptions, now = new Date()) {
  const entry = inventory[repo];
  const exception = exceptions.find(
    (e) => e.repo === repo && e.control === control.id && new Date(e.expires) > now,
  );
  if (exception) {
    return { status: "excepted", reason: `Active exception ${exception.id} until ${exception.expires}` };
  }
  if (!entry) {
    return { status: "in_scope", unclassified: true, reason: "Unclassified: treated as production (fail-secure)" };
  }
  if (entry.review_by && new Date(entry.review_by) < now) {
    return { status: "in_scope", unclassified: true, reason: `Classification '${entry.environment}' expired on ${entry.review_by}: treated as production` };
  }
  if (!control.scope.in_scope_environments.includes(entry.environment)) {
    return { status: "out_of_scope", reason: `Classified '${entry.environment}' by ${entry.classified_by}` };
  }
  return { status: "in_scope", reason: `Classified '${entry.environment}'` };
}
