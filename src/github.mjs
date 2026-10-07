// Minimal GitHub REST client.
//
// Two identities on purpose (least privilege + separation of duties):
//   admin: changes settings on the monitored repos (in Actions: a fine-grained PAT
//          limited to the lab repos with Administration + Issues write).
//   bot:   writes alerts in this control-plane repo (in Actions: GITHUB_TOKEN, so
//          alerts come from github-actions[bot] and you get notified).
// Locally both fall back to your `gh auth token`.
import { execSync } from "node:child_process";

const API = "https://api.github.com";

function ghCliToken() {
  try {
    return execSync("gh auth token", { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

export function github(token) {
  if (!token) throw new Error("No GitHub token: set GH_ADMIN_TOKEN or log in with `gh auth login`");

  async function request(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "grc-engineering-lab",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status}: ${data?.message ?? text}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    patch: (path, body) => request("PATCH", path, body),
    delete: (path) => request("DELETE", path),
  };
}

export function clients() {
  const local = process.env.GH_ADMIN_TOKEN || process.env.GITHUB_TOKEN ? undefined : ghCliToken();
  return {
    admin: github(process.env.GH_ADMIN_TOKEN || local),
    bot: github(process.env.GITHUB_TOKEN || process.env.GH_ADMIN_TOKEN || local),
  };
}

// The repo this code lives in. Alerts and evidence are written here.
export const CONTROL_REPO = process.env.GITHUB_REPOSITORY || "TheEraptic/GRC-Engineering";
