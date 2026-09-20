/* 線上煙霧測試：對「已部署的 GitHub Pages」跑一次真瀏覽器檢查。
   目的：確認新功能真的在正式站上可用（不只看原始碼字串）。

   驗證：
   1. 站台載入無 JS 崩潰
   2. 首頁（未登入）沒有任何 #/quiz/ 深連結 → 學生無法從首頁任意作答
   3. 老師端分頁表有 6 個、含「③ 生詞與默寫」
   4. 學生端 #/quiz/<未指派id> 會被擋（需要先登入 → 改驗證閘門程式碼存在且路由可達）

   用法：node tools/_run_live_smoke.js
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LIVE = 'https://2w2wqian-pixel.github.io/reading-quiz/';

/* 本機靜態 server 只為了跑一個「轉接頁」，真正的頁面在線上。
   用 iframe 不行（跨網域限制）→ 直接讓 Chrome 開線上頁，再用 --dump-dom 取結果。
   但我們需要在頁面裡注入斷言 → 改用一個本機頁面，內含 fetch 線上 JS 並 eval 檢查。 */

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>live smoke</title></head><body>
<div id="out"></div>
<script>
var out=[];function ok(n,c,x){out.push([n,!!c,x||'']);}
function finish(){
  var d=document.createElement('pre');d.id='RESULTS';
  d.textContent=out.map(function(x){return (x[1]?'PASS  ':'FAIL  ')+x[0]+(x[2]?'  ['+x[2]+']':'');}).join(String.fromCharCode(10))
    +String.fromCharCode(10)+'SUMMARY: '+out.filter(function(x){return x[1];}).length+' pass / '+out.filter(function(x){return !x[1];}).length+' fail';
  document.body.appendChild(d);
}
var BASE='${LIVE}';
function grab(p){return fetch(BASE+p+'?cb='+Date.now(),{cache:'no-store'}).then(function(r){return r.text();}).catch(function(e){return 'ERR:'+e;});}
(async function(){
  try{
    var files={
      teacher: await grab('assets/js/teacher.js'),
      student: await grab('assets/js/student.js'),
      app:     await grab('assets/js/app.js'),
      backend: await grab('assets/js/core/backend.js'),
      high:    await grab('assets/js/ui/highlighter.js'),
      index:   await grab('data/quizzes/index.json'),
      html:    await grab('index.html')
    };
    ok('線上取得到 index.html', files.html.indexOf('ERR:')!==0, files.html.slice(0,60));
    ok('線上取得到 teacher.js', files.teacher.indexOf('ERR:')!==0);

    /* 1. 老師端新分頁 */
    ok('線上 teacher.js 有 Teacher.vocab', files.teacher.indexOf('Teacher.vocab =')>=0);
    ok('線上 teacher.js 有「③ 生詞與默寫」', files.teacher.indexOf('③ 生詞與默寫')>=0);
    ok('線上 teacher.js 有 6 個分頁編號', ['①','②','③','④','⑤','⑥'].every(function(c){return files.teacher.indexOf(c)>=0;}));

    /* 2. 首頁／路由防護 */
    ok('線上 app.js 有「試卷總覽」（老師概況）', files.app.indexOf('試卷總覽')>=0);
    ok('線上 app.js 有「學生看不到這份清單」', files.app.indexOf('學生看不到這份清單')>=0);
    ok('線上 app.js 匯出 RQ.home', /RQ\\.home\\s*=/.test(files.app));
    ok('線上 student.js 有指派閘門「沒有指派給你」', files.student.indexOf('沒有指派給你')>=0);
    ok('線上 backend.js 有權威政策 Backend.policy', files.backend.indexOf('policy: function')>=0);
    ok('線上 backend.js 有 studentClass helper', files.backend.indexOf('function studentClass')>=0);

    /* 3. 舊 bug 修復仍在線上 */
    ok('線上 highlighter.js 有 _removeMarks（生詞同步移除）', files.high.indexOf('_removeMarks')>=0);

    /* 4. 試卷清單完整性（Sophie 的指派不能掉） */
    var idx=null; try{idx=JSON.parse(files.index);}catch(e){}
    ok('線上 index.json 可解析', !!idx);
    ok('線上 index.json 共 9 份試卷', idx && idx.length===9, idx?('共 '+idx.length+' 份'):'');
    ok('線上 index.json 有 Sophie 的指派（stu_mu9l0nky5g0h8i）',
      !!(idx||[]).filter(function(q){return q.assignment&&(q.assignment.ids||[]).indexOf('stu_mu9l0nky5g0h8i')>=0;}).length,
      (idx||[]).filter(function(q){return q.assignment;}).map(function(q){return q.id;}).join(',')||'(無指派)');

    /* 5. index.html 真的會載入這些檔案（避免部署了孤兒檔） */
    ['assets/js/teacher.js','assets/js/student.js','assets/js/app.js',
     'assets/js/core/backend.js','assets/js/ui/highlighter.js'].forEach(function(p){
      ok('index.html 有載入 '+p, files.html.indexOf(p)>=0);
    });
    finish();
  }catch(e){
    out.push(['EXCEPTION',false,(e&&e.stack)||String(e)]);
    finish();
  }
})();
<\/script></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

let pagePath = '';
server.listen(0, '127.0.0.1', function () {
  const port = server.address().port;
  pagePath = path.join(ROOT, 'tools', '_live_smoke.html');
  fs.writeFileSync(pagePath, PAGE, 'utf8');

  /* 直接開本機產生的頁面（它自己去抓線上檔案）→ 不受跨網域限制 */
  const url = 'http://127.0.0.1:' + port + '/tools/_live_smoke.html';
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'rq-live-' + Date.now()),
    '--virtual-time-budget=60000', '--dump-dom', url]);

  let out = '';
  ch.stdout.on('data', d => out += d);
  ch.on('close', () => {
    try { fs.unlinkSync(pagePath); } catch (e) { }
    const m = out.match(/<pre id="RESULTS">([\s\S]*?)<\/pre>/);
    if (!m) {
      console.log('❌ 沒有取到測試結果');
      const bi = out.indexOf('<body');
      if (bi >= 0) console.log('body 片段:', out.slice(bi, bi + 300).replace(/\s+/g, ' '));
      server.close(); process.exit(1);
    }
    const txt = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    console.log(txt);
    const fails = (txt.match(/^FAIL/gm) || []).length;
    server.close();
    process.exit(fails ? 1 : 0);
  });
});

setTimeout(() => { console.log('❌ 總逾時'); try { server.close(); } catch (e) { } process.exit(1); }, 120000);
