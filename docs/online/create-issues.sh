#!/usr/bin/env bash
# Creates the MIND-01..07 issues and the MIND-00 epic on GitHub from docs/online/issues/*.md.
# Usage: bash docs/online/create-issues.sh [owner/repo]   (defaults to the repo of the current folder)
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)/issues"
REPO="${1:-}"
LABEL="online-multiplayer"

command -v gh >/dev/null || { echo "GitHub CLI missing: brew install gh && gh auth login" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login" >&2; exit 1; }

repo_args=()
[ -n "$REPO" ] && repo_args=(--repo "$REPO")

gh label create "$LABEL" --color 7E57C2 --description "The Mind online (Supabase)" --force ${repo_args[@]+"${repo_args[@]}"} >/dev/null

keys=()
urls=()
for f in "$DIR"/0[1-9]-*.md; do
  title="$(head -n 1 "$f" | sed 's/^# //')"
  body="$(tail -n +2 "$f")"
  url="$(gh issue create --title "$title" --body "$body" --label "$LABEL" ${repo_args[@]+"${repo_args[@]}"})"
  keys+=("${title%% ·*}")
  urls+=("$url")
  echo "created  $title  ->  $url"
done

epic_title="$(head -n 1 "$DIR/00-epic.md" | sed 's/^# //')"
epic_body="$(tail -n +2 "$DIR/00-epic.md")"
for i in "${!keys[@]}"; do
  pat="- [ ] ${keys[$i]} ·"
  rep="- [ ] ${urls[$i]} ${keys[$i]} ·"
  epic_body="${epic_body//"$pat"/$rep}"
done
epic_url="$(gh issue create --title "$epic_title" --body "$epic_body" --label "$LABEL" ${repo_args[@]+"${repo_args[@]}"})"
echo "created  $epic_title  ->  $epic_url"

echo
echo "Run Heracles on these, in order (merge each PR before the next):"
for i in "${!keys[@]}"; do echo "  ${keys[$i]}  ${urls[$i]}"; done
