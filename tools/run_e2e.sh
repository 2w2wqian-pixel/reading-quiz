#!/bin/sh
# E2E：用真實 Chrome 跑端到端測試（中文試卷 id 路由、生詞本同步、指派制、老師端試卷管理）。
# 用法：sh tools/run_e2e.sh
#
# 兩個關鍵技巧：
# 1. headless Chrome 的 --virtual-time-budget 會讓虛擬時間跑得比真實 I/O 快，
#    --dump-dom 常在 async 完成前就被截斷 → 改用 beacon 把結果打回 server 的 access log，
#    再用真實時間輪詢（詳見 skill: browser-code-node-smoke-test）。
# 2. 測試用「自己的假 repo」目錄（tools/_e2e_data/），**完全不碰 data/** ——
#    那是老師真正的試卷與名冊，之前曾因為測試寫進去而被 commit 上線。
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
# 每次用一個空閒的隨機埠：固定埠若被前次殘留的 server 佔住，
# 新的 server 會 bind 失敗，而請求會落到「log 已被刪掉」的舊 server，導致假逾時。
PORT="${PORT:-$(python -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')}"
CH="/c/Program Files/Google/Chrome/Application/chrome.exe"
PROFILE="$ROOT/tools/_e2e_profile"
TMPPAGE="$ROOT/_e2e_tmp.html"
HTTPLOG="$ROOT/tools/_e2e_httpd.log"
FIXDIR="tools/_e2e_data"
ZH_REPO_ID="中六卷一閱讀能力考核-e2e"

cleanup() {
  rm -f "$TMPPAGE" "$HTTPLOG" tools/_e2e_dom.html
  rm -rf "$FIXDIR" "$PROFILE"          # 測試資料自己一份，結束就清掉
  [ -d "$FIXDIR" ] && echo "!! 警告：$FIXDIR 沒清乾淨"
  pkill -f "http.server $PORT" 2>/dev/null || true
}
trap cleanup EXIT

# 1) 造出測試用的「假 repo」（index + 兩份試卷）。測試頁會把 Published.base 指到這裡。
python3 tools/_e2e_fixture.py "$FIXDIR" "$ZH_REPO_ID"

# 2) 測試頁必須放在 repo 根目錄（Published.base 是相對路徑）
sed 's#\.\./assets/#assets/#g' tools/e2e.html > "$TMPPAGE"

# 3) 起 server（留 access log）與 Chrome
python -m http.server "$PORT" --bind 127.0.0.1 > "$HTTPLOG" 2>&1 &
sleep 2
"$CH" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --user-data-dir="$PROFILE" --virtual-time-budget=180000 \
  --dump-dom "http://127.0.0.1:$PORT/_e2e_tmp.html" > tools/_e2e_dom.html 2>/dev/null &
CHPID=$!

FOUND=""
for i in $(seq 1 90); do
  FOUND=$(grep -o '__e2e?r=[^ &]*' "$HTTPLOG" 2>/dev/null | head -1 || true)
  if [ -n "$FOUND" ]; then break; fi
  sleep 1
done
kill "$CHPID" 2>/dev/null || true
wait "$CHPID" 2>/dev/null || true

if [ -z "$FOUND" ]; then
  echo "TIMEOUT: 沒有收到測試結果（測試頁可能卡住或 server 沒起來）"
  tail -15 "$HTTPLOG" 2>/dev/null || echo "(沒有 log)"
  exit 1
fi

python3 tools/_e2e_report.py "$FOUND"
