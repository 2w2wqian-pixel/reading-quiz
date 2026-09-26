/* 試卷改名功能測試：真的開 index.html，以老師身分進到「② 試卷管理」，
   檢查表格裡有「改名」按鈕，按下後開出對話框、改完名稱後：
     (a) 本機試卷名稱已更新
     (b) 已發佈的試卷會把新名稱寫進 GitHub（用假 fetch 攔截，不會動真資料）

   用法：node tools/_run_rename.js */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>rename test</title>
<link rel="stylesheet" href="/assets/css/app.css"></head><body>
<div id="view"></div><div id="toast-root"></div><div id="modal-root"></div>
<script>
window.__ERR=[];window.__CALLS=[];
window.onerror=function(m){window.__ERR.push(String(m));};
window.addEventListener('unhandledrejection',function(e){window.__ERR.push('rej:'+e.reason);});
window.fetch=function(url,opt){
  url=String(url);window.__CALLS.push({url:url,method:(opt&&opt.method)||'GET'});
  var body='{}';
  if(/quizzes\\/index\\.json/.test(url)&&(!opt||opt.method!=='PUT')) body=JSON.stringify([{id:'test-quiz-0001',title:'原名稱',level:'中二',subject:'中文',published:true}]);
  if(/contents\\//.test(url)) body=JSON.stringify({content:btoa(unescape(encodeURIComponent('{}'))),sha:'x',path:'x'});
  return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(JSON.parse(body));}});
};
<\/script>
<script src="/assets/js/vendor/jszip.min.js"><\/script>
<script src="/assets/js/core/util.js"><\/script>
<script src="/assets/js/core/crypto.js"><\/script>
<script src="/assets/js/core/store.js"><\/script>
<script src="/assets/js/core/backend.js"><\/script>
<script src="/assets/js/core/docx-parser.js"><\/script>
<script src="/assets/js/core/pdf-parser.js"><\/script>
<script src="/assets/js/ui/highlighter.js"><\/script>
<script src="/assets/js/teacher.js"><\/script>
<script src="/assets/js/student.js"><\/script>
<script>
(async function(){
  var out=[];function ok(n,c,extra){out.push([n,!!c,extra||'']);}
  var RQ=window.RQ, U=RQ.util;
  function finish(){
    var d=document.createElement('pre');d.id='RESULTS';
    d.textContent=out.map(function(x){return (x[1]?'PASS  ':'FAIL  ')+x[0]+(x[2]?'  ['+x[2]+']':'');}).join('\\n')
      +'\\nSUMMARY: '+out.filter(function(x){return x[1];}).length+' pass / '+out.filter(function(x){return !x[1];}).length+' fail'
      +'\\nERRS:'+(window.__ERR.join(' | ')||'none');
    document.body.appendChild(d);
  }
  try{
    /* 準備：老師設定 + 一份已發佈的試卷 */
    RQ.settings.set({gh:{owner:'o',repo:'r',branch:'main',token:'t'},quizMode:'github',
      fb:{dbUrl:'',apiKey:'',classCode:'default'}});
    var quiz={id:'test-quiz-0001',title:'原名稱',level:'中二',subject:'中文',
      published:true,passages:[],questions:[],totalMarks:0,createdAt:new Date().toISOString()};
    await RQ.store.quiz.save(quiz);
    ok('前置：GitHub 已設定', RQ.backend.GitHub.ok());

    /* 進到試卷管理頁 */
    var view=document.getElementById('view');
    await RQ.teacher.quizzes(view);
    await new Promise(function(r){setTimeout(r,400);});
    var txt=view.textContent||'';
    ok('試卷管理頁有列出試卷', /原名稱/.test(txt), txt.slice(0,60).replace(/\\n/g,' '));
    ok('表格有「改名」按鈕', /改名/.test(txt));
    ok('原有的「發佈／重新發佈」還在', /重新發佈|發佈/.test(txt));

    /* 按下改名 → 應該開出對話框 */
    var btns=[].slice.call(view.querySelectorAll('button'));
    var rn=btns.filter(function(b){return b.textContent.trim()==='改名';})[0];
    ok('找得到改名按鈕', !!rn);
    if(!rn){finish();return;}
    rn.click();
    await new Promise(function(r){setTimeout(r,200);});
    var modal=document.querySelector('.modal');
    ok('改名對話框有開出來', !!modal);
    if(modal){
      ok('對話框有「新名稱」欄位', /新名稱/.test(modal.textContent||''));
      ok('對話框有說明「不會更動 id」', /id/.test(modal.textContent||''));
      var inp=modal.querySelector('input');
      ok('新名稱輸入框的初值是原名稱', inp && inp.value==='原名稱', inp?inp.value:'(no input)');

      /* 改名並確定 */
      if(inp){
        inp.value='改過的新名稱';
        inp.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(function(r){setTimeout(r,120);});
        var sav=[].slice.call(modal.querySelectorAll('button')).filter(function(b){return b.textContent.trim()==='儲存';})[0];
        ok('有「儲存」按鈕', !!sav);
        if(sav){
          sav.click();
          await new Promise(function(r){setTimeout(r,1500);});
          var q=await RQ.store.quiz.get('test-quiz-0001');
          ok('本機試卷名稱已更新', q && q.title==='改過的新名稱', q?q.title:'(none)');
          ok('試卷 id 沒有改變', q && q.id==='test-quiz-0001', q?q.id:'(none)');
          var wroteQuiz=window.__CALLS.some(function(c){return /test-quiz-0001\\.json/.test(c.url)&&c.method==='PUT';});
          ok('已發佈的試卷有寫回 GitHub 本體', wroteQuiz);
          var wroteIdx=window.__CALLS.some(function(c){return /index\\.json/.test(c.url)&&c.method==='PUT';});
          ok('有更新 GitHub 的試卷清單', wroteIdx);
          out.push(['DEBUG-CALLS', true, JSON.stringify(window.__CALLS.map(function(c){
            return c.method+' '+c.url.replace(/^https:\\/\\/api\\.github\\.com/,'').split('?')[0];
          }))]);
          out.push(['DEBUG-GHOK', true, 'GitHub.ok='+RQ.backend.GitHub.ok()+' token='+(RQ.settings.get().gh||{}).token]);
        }
      }
    }
    finish();
  }catch(e){ ok('執行未拋錯',false,String(e&&e.message||e)); finish(); }
})();
<\/script>
</body></html>`;

(async function () {
  fs.writeFileSync(path.join(ROOT, 'tools', '_rename.html'), PAGE);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const profile = path.join(os.tmpdir(), 'rq-rename-' + Date.now());
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--user-data-dir=' + profile,
    '--virtual-time-budget=40000', '--dump-dom',
    'http://127.0.0.1:' + port + '/tools/_rename.html'], { windowsHide: true });

  let out = '';
  ch.stdout.on('data', d => out += d.toString());
  ch.stderr.on('data', () => { });
  ch.on('close', () => {
    const m = out.match(/<pre id="RESULTS">([\s\S]*?)<\/pre>/);
    if (m) {
      const txt = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      console.log(txt);
      try { server.close(); } catch (e) { }
      /* ⚠ 判斷字串要寫「0 fail」而不是「fail 0」：摘要格式是「16 pass / 0 fail」，
         寫反的話就算全過也會 process.exit(1)，整套看起來永遠是紅的。 */
      process.exit(/\b0 fail\b/.test(txt) ? 0 : 1);
    } else {
      console.log('沒有結果（可能逾時或崩潰）');
      console.log(out.slice(0, 600));
      try { server.close(); } catch (e) { }
      process.exit(1);
    }
  });
  ch.on('error', e => { console.log('FATAL ' + e.message); process.exit(1); });
})();

setTimeout(() => { console.log('FATAL timeout'); process.exit(1); }, 120000);
