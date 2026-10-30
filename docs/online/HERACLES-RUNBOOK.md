# Runbook: Building The Mind Online with Heracles

Heracles (TaskPilot) takes **one issue URL per run**. For each run it creates a branch from the newest `main`, plans the change, writes the code and tests, commits, opens a PR, and self-reviews it. It **never merges**. You merge.

## 0. One-time prerequisites (you)

| Need | Why | How |
|---|---|---|
| A GitHub repo with `origin` | Heracles pulls `main` and opens PRs | Step 1 below |
| GitHub CLI, signed in | Heracles uses `gh` to open PRs. The GitHub MCP server in this VS Code setup can only read. | `brew install gh && gh auth login` |
| Node 20+ | Tests (`node --test`) | already installed (v20.12.2) |
| Docker Desktop (strongly recommended from MIND-03 on) | Local Supabase stack for the pgTAP, integration, and e2e tests. Without it, those tests only run in CI. | docker.com → Docker Desktop |

## 1. Put the project on GitHub

```bash
cd ~/Documents/Agentic/TheMind
cp -R <path-to-this-folder>/docs .          # adds docs/online/**
git init -b main
git add .
git commit -m "chore: import The Mind and online-play requirements"
gh repo create the-mind --public --source . --push   # public, so GitHub Pages is free
```

## 2. Create the issues

```bash
bash docs/online/create-issues.sh            # prints one URL per issue, in run order
```

## 3. Run Heracles once per issue, in order

| Run | Issue | Before you start it | After its PR |
|---|---|---|---|
| 1 | MIND-01 · Extract engine + tests/CI | — | Review, then **merge** |
| 2 | MIND-02 · Multi-human engine | MIND-01 merged | Review, then merge |
| 3 | MIND-03 · Supabase rooms backend | Docker running (recommended) | Review, then merge |
| 4 | MIND-04 · Gameplay server | MIND-02 and MIND-03 merged | Review, then merge |
| 5 | MIND-05 · Online lobby UI | — | Review, then merge |
| 6 | MIND-06 · Online game UI | — | Review, then merge |
| 7 | MIND-07 · Deploy & launch | **Create the Supabase project and the GitHub secrets/variables** (DEPLOY.md is written in this run, so use the list in the MIND-07 issue) | Merge → check the deploy → run `smoke.yml` → 4-device playtest |

Prompt to use for each run (switch to the **Heracles-TaskPilot** agent):

```
Implement https://github.com/<you>/the-mind/issues/<N>.
The hard rules I1–I8 in docs/online/PRD-the-mind-online.md apply.
```

## 4. Rules of thumb

- **Keep it in order.** Each issue builds on the merged result of the one before it. Running two at once creates conflicting branches.
- **Clean tree.** Heracles stops if there are uncommitted changes. Commit or remove them first.
- **If Heracles ends with `partial` or `blocked`,** read its final summary. It tells you what's missing, for example `gh` isn't signed in or Docker isn't running. Fix that and run the same issue again; Heracles reuses the branch.
- **Scope changes:** edit the GitHub issue text, not just the chat. Heracles treats the issue as the source of truth.
- **Your own review is required.** Heracles' AI Review is a self-review. Before merging, look at the privacy tests (I2) and the RLS tests yourself.
