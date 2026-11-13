#!/usr/bin/env python3
"""Publish hermes-token-speed to GitHub and (optionally) open the plugin-catalog PR.

    python publish.py <github-token>              # create repo + push + render catalog entry
    python publish.py <github-token> --catalog    # ...and open the PR against NousResearch/hermes-agent
    GITHUB_TOKEN=... python publish.py --dry-run  # render + print the plan, touch nothing remote

Token: classic with `repo` scope, or a fine-grained token with Administration:write (create repo)
+ Contents:write on the fork (catalog PR). Stdlib only.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = "https://api.github.com"
UPSTREAM = "NousResearch/hermes-agent"
PLUGIN = "token-speed"
ROOT = os.path.dirname(os.path.abspath(__file__))


def call(method: str, path: str, token: str, payload: dict | None = None) -> tuple[int, dict | list | None]:
    url = path if path.startswith("http") else API + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "hermes-token-speed-publisher")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode()
            return r.status, (json.loads(body) if body.strip() else None)
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, {"message": body[:500]}


def git(*args: str, cwd: str = ROOT) -> str:
    out = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if out.returncode:
        raise SystemExit(f"git {' '.join(args)} failed:\n{out.stderr.strip()}")
    return out.stdout.strip()


PR_BODY = """Adds `token-speed` (v1.0.0) pinned at `{sha}`.

**What it does.** A status-bar chip showing live tokens/sec plus this session's up (`prompt`) and down
(`completion`) token totals; clicking it opens a dashboard with a 60-second sparkline, this-turn output
tokens, model, call count, average t/s, cache hit %, context usage % and estimated cost. The rate is
estimated from a 2-second sliding window of streamed characters and recalibrated continuously against the
session's authoritative `UsageStats`, so mixed English/CJK traffic tracks.

**Surfaces used.** Desktop plugin SDK only (`desktop/plugin.js`): a status-bar chip slot, a popover and a
command-palette entry that resets the samples. No agent tools, hooks, middleware, providers or routes.

**Disclosures (rule 13).** No network calls, no telemetry, no file writes, no credential or env reads
(`requires_env: []`), no shell commands, no background processes, nothing stored outside module memory. It
reads the session `UsageStats` and streaming deltas the app already exposes through the plugin SDK.

**Validation.** `hermes plugins validate . --install-deps` passes on 0.23.0: manifest, loadable entry,
capability probe (manifest-only), security scan `safe`, `no core override`, `desktop surface`.
`requires_hermes: ">=0.23.0"` matches `plugin.yaml`.

Repo: {repo} — MIT.
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("token", nargs="?", default=os.environ.get("GITHUB_TOKEN", ""))
    ap.add_argument("--repo-name", default="hermes-token-speed")
    ap.add_argument("--private", action="store_true")
    ap.add_argument("--catalog", action="store_true", help="also open the plugin-catalog PR")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    sha = git("rev-parse", "HEAD")
    owner = os.environ.get("GH_OWNER", "OWNER")

    if a.dry_run or not a.token:
        if not a.dry_run:
            print("no token given — dry run\n", file=sys.stderr)
        tmpl = open(os.path.join(ROOT, "catalog", "token-speed.yaml.tmpl"), encoding="utf-8").read()
        rendered = tmpl.replace("{{OWNER}}", owner).replace("{{SHA}}", sha)
        out = os.path.join(ROOT, "catalog", f"{PLUGIN}.yaml")
        open(out, "w", encoding="utf-8", newline="\n").write(rendered)
        print(f"pinned sha : {sha}")
        print(f"rendered   : {out}")
        print(rendered)
        print("plan: POST /user/repos -> git push -> render catalog -> " + ("PR" if a.catalog else "stop"))
        return 0

    status, me = call("GET", "/user", a.token)
    if status != 200 or not isinstance(me, dict) or "login" not in me:
        print(f"token rejected ({status}): {me}", file=sys.stderr)
        return 1
    owner = me["login"]
    print(f"==> {owner}/{a.repo_name}")

    status, body = call("POST", "/user/repos", a.token, {
        "name": a.repo_name,
        "description": "Live token generation speed and session up/down totals in the Hermes Desktop status bar",
        "private": a.private,
        "has_issues": True,
        "has_wiki": False,
    })
    if status == 201:
        print("    repo created")
    elif status == 422:
        print("    repo exists, pushing into it")
    else:
        print(f"    create failed ({status}): {body}", file=sys.stderr)
        return 1

    repo_url = f"https://github.com/{owner}/{a.repo_name}"
    print("==> push main")
    git("branch", "-M", "main")
    subprocess.run(["git", "push", f"https://x-access-token:{a.token}@github.com/{owner}/{a.repo_name}.git",
                    "main", "--force"], cwd=ROOT, check=True, capture_output=True)
    subprocess.run(["git", "remote", "remove", "origin"], cwd=ROOT, capture_output=True)
    git("remote", "add", "origin", repo_url)

    tmpl = open(os.path.join(ROOT, "catalog", "token-speed.yaml.tmpl"), encoding="utf-8").read()
    entry_path = os.path.join(ROOT, "catalog", f"{PLUGIN}.yaml")
    entry = tmpl.replace("{{OWNER}}", owner).replace("{{SHA}}", sha)
    open(entry_path, "w", encoding="utf-8", newline="\n").write(entry)
    print(f"==> catalog entry rendered: {entry_path}")

    print(f"\nRepo:    {repo_url}")
    print(f"Install: hermes plugins install {repo_url}")
    if not a.catalog:
        print(f"\nCatalog PR: python publish.py {a.token} --catalog")
        return 0

    print(f"==> fork {UPSTREAM}")
    call("POST", f"/repos/{UPSTREAM}/forks", a.token, {"default_branch_only": True})
    for _ in range(40):
        st, fork = call("GET", f"/repos/{owner}/hermes-agent", a.token)
        if st == 200:
            break
        time.sleep(5)
    else:
        print("    fork never appeared", file=sys.stderr)
        return 1

    branch = f"plugin-catalog/{PLUGIN}"
    st, ref = call("GET", f"/repos/{owner}/hermes-agent/git/ref/heads/main", a.token)
    base = ref["object"]["sha"]
    st, _ = call("POST", f"/repos/{owner}/hermes-agent/git/refs", a.token,
                 {"ref": f"refs/heads/{branch}", "sha": base})
    print(f"    branch {branch} @ {base[:7]}" + ("" if st in (200, 201) else " (reusing)"))

    path = f"/repos/{owner}/hermes-agent/contents/plugin-catalog/{PLUGIN}.yaml"
    st, existing = call("GET", f"{path}?ref={branch}", a.token)
    payload = {
        "message": f"Add {PLUGIN} to the plugin catalog",
        "content": base64.b64encode(entry.encode()).decode(),
        "branch": branch,
    }
    if st == 200 and isinstance(existing, dict):
        payload["sha"] = existing["sha"]
    st, res = call("PUT", path, a.token, payload)
    if st not in (200, 201):
        print(f"    commit failed ({st}): {res}", file=sys.stderr)
        return 1
    print("    catalog file committed")

    st, pr = call("POST", f"/repos/{UPSTREAM}/pulls", a.token, {
        "title": f"Add {PLUGIN} to the plugin catalog",
        "head": f"{owner}:{branch}",
        "base": "main",
        "body": PR_BODY.format(sha=sha, repo=repo_url),
    })
    if st not in (200, 201):
        print(f"    PR failed ({st}): {pr}", file=sys.stderr)
        return 1
    print(f"\nPR: {pr['html_url']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
