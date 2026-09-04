#!/usr/bin/env bash
# Counts ✅ / 🟡 / ❌ statuses in the draft-18 feature audit and prints a bar.
#
# Usage: scripts/audit-progress.sh
#   -w  emit an HTML/MD-style progress block on stdout (for pasting into docs)

set -euo pipefail

DOC="$(cd "$(dirname "$0")/.." && pwd)/docs/draft-18-feature-audit.md"

if [[ ! -f "$DOC" ]]; then
  echo "audit doc not found: $DOC" >&2
  exit 1
fi

# Only count status cells (last column of table rows). Table rows start with "| ".
# We match on the exact glyphs used in the doc.
complete=$(grep -c '| ✅' "$DOC" || true)
partial=$(grep -c '| 🟡' "$DOC" || true)
missing=$(grep -c '| ❌' "$DOC" || true)
total=$((complete + partial + missing))

if [[ $total -eq 0 ]]; then
  echo "no status rows found — check the doc format" >&2
  exit 1
fi

pct_complete=$((complete * 100 / total))
pct_partial=$((partial * 100 / total))
pct_missing=$((missing * 100 / total))

# ASCII progress bar (40 chars wide)
width=40
bar_c=$((complete * width / total))
bar_p=$((partial * width / total))
bar_m=$((width - bar_c - bar_p))

bar=""
for ((i=0; i<bar_c; i++)); do bar+="█"; done
for ((i=0; i<bar_p; i++)); do bar+="▓"; done
for ((i=0; i<bar_m; i++)); do bar+="░"; done

printf "MOQ Transport Draft-18 audit — %d features\n" "$total"
printf "[%s]\n" "$bar"
printf "  ✅ Complete: %2d (%d%%)\n" "$complete" "$pct_complete"
printf "  🟡 Partial : %2d (%d%%)\n" "$partial" "$pct_partial"
printf "  ❌ Missing : %2d (%d%%)\n" "$missing" "$pct_missing"

if [[ "${1:-}" == "-w" ]]; then
  # Rewrite the block between the audit-progress markers in place.
  tmp=$(mktemp)
  awk -v c="$complete" -v p="$partial" -v m="$missing" -v pct="$pct_complete" -v tot="$total" '
    /<!-- audit-progress:begin -->/ {
      print
      printf "**Progress:** ✅ %d · 🟡 %d · ❌ %d · **%d%% complete** of %d features\n", c, p, m, pct, tot
      in_block=1
      next
    }
    /<!-- audit-progress:end -->/ {
      in_block=0
      print
      next
    }
    !in_block { print }
  ' "$DOC" > "$tmp"
  mv "$tmp" "$DOC"
  echo "updated progress block in $DOC" >&2
fi
