#!/bin/sh
# PDF 解析探測器（真實 Chrome）
# 用法：sh tools/run_pdfprobe.sh <tools目錄底下的pdf檔名> [mode] [lang]
# 例：sh tools/run_pdfprobe.sh _math.pdf image
#     sh tools/run_pdfprobe.sh _en.pdf auto en
#
# 三個實測踩過的坑：
# 1. 用 beacon 把結果打回 server 的 access log，再以「真實時間」輪詢 ——
#    --virtual-time-budget 會讓虛擬時間跑得比 pdf.js worker 的實際 I/O 快，
#    只靠 --dump-dom 會在完成前就被截斷。
# 2. 所有暫存檔一律放 repo 內的相對路徑：Git Bash 的 /tmp 與 Windows Python 的
#    /tmp 不是同一個目錄，把 log 寫在 /tmp 再用 Python 讀會找不到檔案。
# 3. 不要用 pkill（在此環境偶爾會連呼叫端的 shell 一起殺掉，輸出會整個消失）
#    —— 用 $! 記 PID，最後精準 kill。
set -u
cd "$(dirname "$0")/.."

FILE="${1:?請給 PDF 檔名（放在 tools/ 底下）}"
MODE="${2:-auto}"
LANG="${3:-}"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"

LOG="tools/_pdfprobe_httpd.log"
BEACON="tools/_pdfprobe_result.txt"
# Chrome 的 profile 一定要放系統暫存目錄、且每次用不同目錄：
# 放 repo 內、前一次被中途殺掉會留下鎖檔 → Chrome 直接退出，beacon 永遠不會來（實測踩過）。
PROF="$TEMP/rq_pdfprobe_$$"

rm -f "$LOG" "$BEACON"

PORT=$(python -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')

python -m http.server "$PORT" --bind 127.0.0.1 > "$LOG" 2>&1 &
SRV=$!
sleep 2

URL="http://127.0.0.1:$PORT/tools/pdfprobe.html?f=$FILE&mode=$MODE&lang=$LANG"
"$CHROME" --headless=new --disable-gpu --no-sandbox --user-data-dir="$PROF" "$URL" >/dev/null 2>&1 &
CHR=$!

i=0
FOUND=0
while [ "$i" -lt 30 ]; do
  i=$((i + 1)); sleep 3
  if grep -q "__pdf?r=" "$LOG" 2>/dev/null; then FOUND=1; break; fi
  echo "  ...等待結果 ($((i * 3))s)"
  echo "  ...等待結果 ($((i * 3))s)"
done

if [ "$FOUND" = "1" ]; then
  grep -o "__pdf?r=[^ &]*" "$LOG" | head -1 | sed 's/^__pdf?r=//' > "$BEACON"
fi

kill "$CHR" 2>/dev/null
kill "$SRV" 2>/dev/null
sleep 1

if [ ! -s "$BEACON" ]; then
  echo "TIMEOUT：沒有收到結果（worker 可能載入失敗或頁面卡住）"
  echo "--- log 尾巴 ---"
  tail -5 "$LOG" 2>/dev/null
  exit 1
fi

python3 tools/_pdfprobe_decode.py "$BEACON"
