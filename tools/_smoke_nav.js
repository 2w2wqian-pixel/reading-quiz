/* 煙霧測試：真的開 index.html，看導覽列與設定頁有沒有渲染出來 */
const http=require('http'),fs=require('fs'),path=require('path'),{spawn}=require('child_process'),os=require('os');
const ROOT=path.resolve(__dirname,'..');
const CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html';
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);res.end('nf');return;}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f).toLowerCase()]||'application/octet-stream'});
  fs.createReadStream(f).pipe(res);
});
server.listen(0,'127.0.0.1',()=>{
  const port=server.address().port;
  const profile=path.join(os.tmpdir(),'rq-smoke-'+Date.now());
  const ch=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--no-first-run',
    '--disable-dev-shm-usage','--user-data-dir='+profile,'--virtual-time-budget=15000','--dump-dom',
    'http://127.0.0.1:'+port+'/index.html'],{windowsHide:true});
  let out=''; ch.stdout.on('data',d=>out+=d.toString()); ch.stderr.on('data',()=>{});
  ch.on('close',()=>{
    let fails=0;
    const checks=[
      ['導覽列有 Google 登入按鈕', /使用 Google 登入/.test(out)],
      ['導覽列有學生登入連結', /學生登入/.test(out)],
      ['導覽列有老師登入連結', /老師登入/.test(out)],
      ['頁面沒有 JS 崩潰痕跡', !/Uncaught|ReferenceError|TypeError/.test(out)]
    ];
    checks.forEach(([n,ok])=>{ console.log((ok?'PASS  ':'FAIL  ')+n); if(!ok)fails++; });
    console.log('SUMMARY: '+(checks.length-fails)+' pass / '+fails+' fail');
    try{server.close();}catch(e){}
    process.exit(fails?1:0);
  });
  ch.on('error',e=>{console.log('FATAL '+e.message);process.exit(1);});
});
setTimeout(()=>{console.log('FATAL timeout');process.exit(1);},60000);
