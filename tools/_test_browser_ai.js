/* 瀏覽器端煙霧測試（headless Chrome）
   1. 開 index.html，確認新載入的 md-parser.js／ai.js 沒有炸掉任何東西
   2. 進老師設定頁，確認「⑤ AI 助理」卡片渲染出來、欄位可讀寫
   3. 用 md-parser 跑一次真實的 Markdown 字串（模擬貼上文字後的解析）
   執行： node tools/_test_browser_ai.js
*/
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.RQ_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

/* 掛在 window 上的探針腳本：等 app.js 跑完，再切到設定頁渲染 */
const PROBE = [
  '<script>',
  'window.__errs = [];',
  'window.addEventListener("error", function(e){ window.__errs.push(String(e.message||e)); });',
  'window.addEventListener("load", function(){',
  '  setTimeout(function(){',
  '    var lines = [];',
  '    try {',
  '      var RQ = window.RQ;',
  '      RQ.settings.set({ session: { role: "teacher" } });',
  '      /* 切到 Gemini 通道，讓 Gemini 專屬的說明框也一起渲染（才驗得到） */',
  '      if (RQ.ai) RQ.ai.save({ provider: "gemini" });',
  '      var view = document.getElementById("view");',
  '      if (RQ.teacher && RQ.teacher.data) RQ.teacher.data(view);',
  '      lines.push("OK");',
  '    } catch (e) { lines.push("THREW: " + (e && e.stack || e)); }',
  '    lines.push("ERRORS: " + JSON.stringify(window.__errs));',
  '    var d = document.createElement("pre"); d.id = "po"; d.textContent = lines.join("\\n");',
  '    document.body.appendChild(d);',
  '  }, 1500);',
  '});',
  '<\/script>'
].join('\n');

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const profile = path.join(os.tmpdir(), 'rq-aitest-' + Date.now());

  /* 先把探針注入一份臨時 index，避免污染 repo */
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const patched = src.replace('</body>', PROBE + '\n</body>');
  fs.writeFileSync(path.join(ROOT, '_tmp_probe.html'), patched);

  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--user-data-dir=' + profile,
    '--virtual-time-budget=20000', '--dump-dom',
    'http://127.0.0.1:' + port + '/_tmp_probe.html'], { windowsHide: true });

  let out = '';
  ch.stdout.on('data', d => out += d.toString());
  ch.stderr.on('data', () => {});
  ch.on('close', () => {
    try { fs.unlinkSync(path.join(ROOT, '_tmp_probe.html')); } catch (e) {}

    const text = out.replace(/<[^>]+>/g, ' ');
    /* 只看 <h3> 的編號，避免把內文交叉引用（例如「⑤ 學生名冊」）算進去 */
    const h3s = (out.match(/<h3[^>]*>[^<]*/g) || []).map(s => s.replace(/<h3[^>]*>/, ''));
    const numbers = h3s.map(s => (s.match(/^[①②③④⑤⑥⑦⑧⑨]/) || [''])[0]).filter(Boolean);
    const dupNumbers = numbers.filter((n, i) => numbers.indexOf(n) !== i);

    let fails = 0;
    const checks = [
      /* 探針會回報實際發生的錯誤（不能直接掃 dump-dom，因為探針程式碼本身含 "THREW" 字樣） */
      ['頁面沒有 JS 崩潰', (function () {
        const m = out.match(/<pre id="po">([\s\S]*?)<\/pre>/);
        if (!m) return false;
        const t = m[1].replace(/&quot;/g, '"');
        return /^OK/m.test(t) && /ERRORS: \[\]/.test(t);
      })()],
      ['md-parser.js 有被載入', /md-parser\.js/.test(out)],
      ['ai.js 有被載入', /ai\.js/.test(out)],
      ['設定頁渲染出「AI 助理」卡片', /<h3[^>]*>⑤ AI 助理/.test(out)],
      ['設定頁有「使用哪個通道」', /使用哪個通道/.test(text)],
      ['設定頁有「儲存並測試連線」', /儲存並測試連線/.test(text)],
      ['設定頁有 direct 通道的 API 端點欄位', /API 端點/.test(text)],
      ['設定頁有隱私提醒', /試卷的文字會離開這台電腦/.test(text)],
      ['設定頁有 Ollama 離線建議', /Ollama/.test(text)],
      ['設定頁有 Gemini 免費金鑰取得說明', /aistudio\.google\.com\/apikey/.test(text)],
      ['設定頁有「看看我的金鑰能用哪些模型」按鈕', /看看我的金鑰能用哪些模型/.test(text)],
      ['設定頁有 Gemini 免費層限制提醒', /每分鐘 10 次/.test(text)],
      ['設定頁的卡片編號（h3）沒有重複', dupNumbers.length === 0]
    ];
    checks.forEach(([n, ok]) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + n); if (!ok) fails++; });

    console.log('\nh3 編號：' + h3s.map(s => s.slice(0, 14)).join(' | '));
    console.log('SUMMARY: ' + (checks.length - fails) + ' pass / ' + fails + ' fail');
    try { server.close(); } catch (e) {}
    process.exit(fails ? 1 : 0);
  });
  ch.on('error', e => { console.log('FATAL ' + e.message); process.exit(1); });
});
setTimeout(() => { console.log('FATAL timeout'); process.exit(1); }, 90000);
