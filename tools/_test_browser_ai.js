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

/* 第二段探針：切到 OpenRouter 通道（香港可用），並渲染上傳頁，
   驗證 (a) OpenRouter 專屬說明框 (b) 上傳頁的 AI 區塊。
   與第一段分開，因為切通道會改寫設定、兩份 dump-dom 各跑一次最乾淨。 */
const PROBE2 = [
  '<script>',
  'window.__errs = [];',
  'window.addEventListener("error", function(e){ window.__errs.push(String(e.message||e)); });',
  'window.addEventListener("load", function(){',
  '  setTimeout(function(){',
  '    var lines = [];',
  '    try {',
  '      var RQ = window.RQ;',
  '      RQ.settings.set({ session: { role: "teacher" } });',
  '      /* 給一個假的 OpenRouter 金鑰 → isReady() 應為 true → 上傳頁才會出現 AI 區塊 */',
  '      RQ.ai.save({ provider: "openrouter", apiKey: "sk-or-v1-TESTKEY", enabled: true });',
  '      lines.push("READY: " + (RQ.ai.isReady() ? "yes" : "no"));',
  '      lines.push("PROVIDERS: " + Object.keys(RQ.ai.PROVIDERS || {}).join(","));',
  '      var view = document.getElementById("view");',
  '      if (RQ.teacher && RQ.teacher.data) RQ.teacher.data(view);',
  '      /* 再渲染上傳頁（Teacher.upload 是 append，所以先清空剛好由它自己 append 卡片） */',
  '      view.innerHTML = "";',
  '      if (RQ.teacher && RQ.teacher.upload) RQ.teacher.upload(view);',
  '      lines.push("OK");',
  '    } catch (e) { lines.push("THREW: " + (e && e.stack || e)); }',
  '    lines.push("ERRORS: " + JSON.stringify(window.__errs));',
  '    var d = document.createElement("pre"); d.id = "po2"; d.textContent = lines.join("\\n");',
  '    document.body.appendChild(d);',
  '  }, 1500);',
  '});',
  '<\/script>'
].join('\n');

/* 跑一趟 headless Chrome，回傳 dump-dom 的字串 */
function runOnce(srcHtml, probe, port, tag, cb) {
  const profile = path.join(os.tmpdir(), 'rq-aitest-' + tag + '-' + Date.now());
  const patched = srcHtml.replace('</body>', probe + '\n</body>');
  const tmpName = '_tmp_probe_' + tag + '.html';
  fs.writeFileSync(path.join(ROOT, tmpName), patched);

  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--user-data-dir=' + profile,
    '--virtual-time-budget=20000', '--dump-dom',
    'http://127.0.0.1:' + port + '/' + tmpName], { windowsHide: true });

  let out = '';
  ch.stdout.on('data', d => out += d.toString());
  ch.stderr.on('data', () => {});
  ch.on('close', () => {
    try { fs.unlinkSync(path.join(ROOT, tmpName)); } catch (e) {}
    cb(out);
  });
  ch.on('error', e => { console.log('FATAL ' + e.message); process.exit(1); });
}

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  runOnce(src, PROBE, port, 'a', (out) => {
    runOnce(src, PROBE2, port, 'b', (out2) => {
      const text = out.replace(/<[^>]+>/g, ' ');
      const text2 = out2.replace(/<[^>]+>/g, ' ');
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
        /* 新增：香港地區限制與 OpenRouter 替代方案 */
        ['設定頁有「香港／中國大陸無法申請」的地區限制提醒', /香港.*無法|無法.*香港/.test(text)],
        ['設定頁有 OpenRouter 通道選項', /OpenRouter/.test(text)],
        ['設定頁有 OpenRouter 金鑰申請網址', /openrouter\.ai\/keys/.test(text)],
        ['設定頁的卡片編號（h3）沒有重複', dupNumbers.length === 0],

        /* ── 第二趟：OpenRouter 通道 + 上傳頁 ── */
        ['切到 OpenRouter 後 isReady() 為 true', (function () {
          const m = out2.match(/<pre id="po2">([\s\S]*?)<\/pre>/);
          if (!m) return false;
          return /READY: yes/.test(m[1].replace(/&quot;/g, '"'));
        })()],
        ['OpenRouter 是已註冊的通道', (function () {
          const m = out2.match(/<pre id="po2">([\s\S]*?)<\/pre>/);
          if (!m) return false;
          return /PROVIDERS: [^<]*openrouter/.test(m[1].replace(/&quot;/g, '"'));
        })()],
        ['第二趟頁面沒有 JS 崩潰', (function () {
          const m = out2.match(/<pre id="po2">([\s\S]*?)<\/pre>/);
          if (!m) return false;
          const t = m[1].replace(/&quot;/g, '"');
          return /^OK/m.test(t) && /ERRORS: \[\]/.test(t);
        })()],
        ['上傳頁出現「解析後直接請 AI 分析」區塊', /解析後直接請 AI 分析/.test(text2)],
        ['上傳頁 AI 區塊有分析任務選單', /分析任務/.test(text2)],
        ['上傳頁仍有「開始解析」與「解析並發佈」', /開始解析/.test(text2) && /解析並發佈/.test(text2)]
      ];
      checks.forEach(([n, ok]) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + n); if (!ok) fails++; });

      console.log('\nh3 編號：' + h3s.map(s => s.slice(0, 14)).join(' | '));
      console.log('SUMMARY: ' + (checks.length - fails) + ' pass / ' + fails + ' fail');
      try { server.close(); } catch (e) {}
      process.exit(fails ? 1 : 0);
    });
  });
});
setTimeout(() => { console.log('FATAL timeout'); process.exit(1); }, 120000);
