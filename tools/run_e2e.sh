#!/bin/sh
# E2E：以真實 Chrome 跑「中文試卷 id 路由」與「生詞本同步」的端到端測試。
# 用法：sh tools/run_e2e.sh
#
# 技巧：headless Chrome 的 --virtual-time-budget 會讓虛擬時間跑得比真實 I/O 快，
# 因此不用 --dump-dom 取結果，而是讓測試頁把結果打回本機 server 的 access log，
# 再用真實時間輪詢該 log（詳見 skill: browser-code-node-smoke-test）。
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
REPO_QUIZ="data/quizzes/中六卷一閱讀能力考核-e2e.json"
ZH_REPO_ID="中六卷一閱讀能力考核-e2e"
IDX_BAK="$ROOT/tools/_e2e_index.bak"

# 先把老師真正的試卷清單複製一份備份（測試會往裡面加東西）
cp -f data/quizzes/index.json "$IDX_BAK"

cleanup() {
  rm -f "$TMPPAGE" "$REPO_QUIZ" "$HTTPLOG" tools/_e2e_dom.html
  # 用備份還原試卷清單（不能只靠 git，否則測試資料會被 commit 進去）
  if [ -f "$IDX_BAK" ]; then cp -f "$IDX_BAK" data/quizzes/index.json; rm -f "$IDX_BAK"; fi
  if grep -q "e2e" data/quizzes/index.json 2>/dev/null; then
    echo "!! 警告：data/quizzes/index.json 仍有測試殘留，請檢查！"
  fi
  rm -rf "$PROFILE"
  pkill -f "http.server $PORT" 2>/dev/null || true
}
trap cleanup EXIT

# 1) 造出一份「只在 repo（已發佈）」的試卷，模擬老師發佈後的狀態
python3 - "$REPO_QUIZ" "$ZH_REPO_ID" <<'PY'
import json, sys
path, qid = sys.argv[1], sys.argv[2]
quiz = {
    "id": qid, "title": "中六卷一閱讀能力考核（已發佈）", "level": "中六", "source": "e2e",
    "published": True, "totalMarks": 3, "passages": [],
    "questions": [{"no": 1, "id": "q1", "type": "text", "stem": "試解釋文意。", "marks": 3}],
    "createdAt": "2026-09-17T00:00:00.000Z"
}
open(path, "w", encoding="utf-8").write(json.dumps(quiz, ensure_ascii=False, indent=2))
idx = json.load(open("data/quizzes/index.json", encoding="utf-8"))
if not any(x.get("id") == qid for x in idx):
    idx.append({"id": qid, "title": quiz["title"], "level": "中六", "source": "e2e",
                "questionCount": 1, "totalMarks": 3, "passageCount": 0,
                "createdAt": quiz["createdAt"], "published": True})
json.dump(idx, open("data/quizzes/index.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("seeded repo quiz:", qid)
PY

# 2) 測試頁必須放在 repo 根目錄，Published.base='data/' 才會解析到正確位置
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
  echo "--- server log（最後 15 行）---"
  tail -15 "$HTTPLOG" 2>/dev/null || echo "(沒有 log)"
  echo "--- 是否曾請求測試頁？ ---"
  grep -c "_e2e_tmp.html" "$HTTPLOG" 2>/dev/null || echo 0
  exit 1
fi

python3 - "$FOUND" <<'PY'
import sys, urllib.parse
line = urllib.parse.unquote(sys.argv[1].split('r=', 1)[1])
print('RESULT LINE:', line[:160].replace('||', ' | ') if len(line) > 160 else line)
if line.startswith('START') and line.endswith('END'):
    body = line[5:-3]
    parts = body.split('||')
    npass = nfail = 0
    for p in parts:
        if p.startswith('PASS::'):
            npass += 1; print('  PASS  ' + p[6:])
        elif p.startswith('FAIL::'):
            nfail += 1; print('  FAIL  ' + p[6:].replace('::', ' :: '))
        elif p.startswith('ERRS::'):
            v = p.split('::', 1)[1] if '::' in p else ''
            if v.strip() and v.strip() != 'undefined':
                print('  JS ERRORS: ' + v)
        elif p.startswith('FATAL::'):
            v = p.split('::', 1)[1] if '::' in p else ''
            if v.strip() and v.strip() != 'undefined':
                print('  FATAL: ' + v)
    print('SUMMARY: %d pass / %d fail' % (npass, nfail))
    raise SystemExit(1 if nfail else 0)
else:
    print('MALFORMED RESULT')
    raise SystemExit(1)
PY
