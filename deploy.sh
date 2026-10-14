#!/usr/bin/env bash
# 배포 — 자산 주소에 새 식별자를 붙여 브라우저가 옛 앱을 쓰지 못하게 한다.
#
#   ./deploy.sh "커밋 메시지"
#
# 식별자를 안 붙이면 캐시된 예전 app.js가 계속 돌아, 새 기능이 동작하지 않는다.
set -euo pipefail
cd "$(dirname "$0")"

STAMP=$(date +%Y%m%d%H%M%S)
sed -i '' -E "s|(src/theme\.css)(\?v=[0-9a-z]*)?|\1?v=$STAMP|; s|(src/app\.js)(\?v=[0-9a-z]*)?|\1?v=$STAMP|" index.html
echo "자산 식별자: $STAMP"

if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "${1:-chore: deploy}"
  git push -q origin main
  echo "커밋·푸시 완료"
fi

npx --yes vercel@latest --prod --yes 2>&1 | grep -E "Production URL" | tail -1
