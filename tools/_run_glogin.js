/* 用真實瀏覽器跑 tools/_glogin.html（Google 登入／綁定的 UI 測試）。
   為什麼需要真的瀏覽器：Node 端測不到「按鈕有沒有出現、點下去有沒有換頁、
   session 最後存了什麼」——這些只有真的 DOM 與 localStorage 才算數。
   要點：
     ① 用隨機空閒埠（固定埠會被殘留的 server 佔住 → 假逾時）
     ② --user-data-dir 放 $TEMP（放 repo 內、前次被殺留鎖檔 → Chrome 直接退出）
     ③ 測試頁把所有 fetch 都攔掉，所以完全離線、也不會寫到老師的真資料
   用法：node tools/_run_glogin.js                                              */
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg'
};

const server = http.createServer(function (req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

let finished = false;
function done(code, msg) {
  if (finished) return;
  finished = true;
  if (msg) console.log(msg);
  try { server.close(); } catch (e) { }
  process.exit(code);
}

server.listen(0, '127.0.0.1', function () {
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/tools/_glogin.html';
  const profile = path.join(os.tmpdir(), 'rq-glogin-' + Date.now());
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--hide-scrollbars',
    '--user-data-dir=' + profile,
    /* 這個預算要跟著測試的「輪詢總量」長大：每一個 until() 都可能吃掉數秒，
       測試段落變多之後 20000 會只剩一半的結果（看起來像卡住，其實是被截斷）。 */
    '--virtual-time-budget=60000',
    '--dump-dom', url
  ];
  const ch = spawn(CHROME, args, { windowsHide: true });
  let out = '';
  ch.stdout.on('data', d => { out += d.toString(); });
  ch.stderr.on('data', () => { });
  ch.on('error', e => done(1, 'FATAL 無法啟動 Chrome：' + e.message));
  ch.on('close', function () {
    const m = /<pre id="rqtest">([\s\S]*?)<\/pre>/.exec(out);
    if (!m) {
      done(1, 'FATAL 頁面沒有產生測試結果（可能卡住或腳本錯誤）\n--- DOM 片段 ---\n' +
        out.slice(0, 1200));
      return;
    }
    const text = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const bad = /FAIL/.test(text);
    done(bad ? 1 : 0, text);
  });
});

setTimeout(() => done(1, 'FATAL 逾時（120 秒）'), 120000);
