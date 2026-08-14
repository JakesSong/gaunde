#!/usr/bin/env bash
# public/ 을 gh-pages 브랜치 루트로 밀어 GitHub Pages 에 배포한다.
#
#   사용법: npm run deploy:pages
#
# Pages 설정은 Settings > Pages > Deploy from a branch > gh-pages / (root).
# GitHub Actions 워크플로를 쓰지 않으므로 gh 토큰에 workflow 스코프가 필요 없다.
# 프런트(public/)를 고칠 때마다 main 에 커밋한 뒤 이 스크립트를 다시 돌리면 된다.
set -euo pipefail
cd "$(dirname "$0")/.."

# 자산 버전 도장이 최신인지 (npm run deploy:pages 가 먼저 찍어준다)
if ! node scripts/stamp-assets.mjs --check >/dev/null 2>&1; then
  echo "자산 버전이 오래됐습니다. \`npm run stamp\` 후 커밋하세요." >&2
  exit 1
fi

if [ -n "$(git status --porcelain public/)" ]; then
  echo "public/ 에 커밋되지 않은 변경이 있습니다. 먼저 커밋하세요." >&2
  git status --short public/ >&2
  exit 1
fi

echo "→ public/ 을 gh-pages 로 분리"
git branch -D gh-pages >/dev/null 2>&1 || true
git subtree split --prefix=public -b gh-pages >/dev/null

echo "→ origin/gh-pages 로 푸시"
git push -f origin gh-pages

echo "✓ https://jakessong.github.io/gaunde/"
