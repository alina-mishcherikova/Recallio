#!/usr/bin/env bash
# PostToolUse hook: format + lint the file Claude just edited.
# No-op until Prettier/ESLint are installed (LEX-001), so it never blocks early work.
set -u
file=$(jq -r '.tool_input.file_path // empty')
[ -z "$file" ] || [ ! -f "$file" ] && exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
case "$file" in
  */node_modules/*|*/.nuxt/*|*/.output/*) exit 0 ;;
esac
case "$file" in
  *.ts|*.vue|*.js|*.mjs|*.json|*.md|*.css|*.yml|*.yaml)
    [ -x node_modules/.bin/prettier ] && node_modules/.bin/prettier --write --log-level warn "$file" ;;
esac
case "$file" in
  *.ts|*.vue|*.js|*.mjs)
    if [ -x node_modules/.bin/eslint ]; then
      out=$(node_modules/.bin/eslint --fix "$file" 2>&1) || { echo "$out" >&2; exit 2; }
    fi ;;
esac
exit 0
