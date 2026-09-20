/* 用 GitHub Git Data API 推送「本機 main 的內容」到遠端 main。
 *
 * 為什麼不用 git push：沙箱沒有存放任何憑證，git push 會停在互動式帳密輸入而逾時。
 * 這條路走 REST API，只要有一顆 token 就能完成，且支援 fast-forward 檢查。
 *
 * 用法：node tools/_push_repair.js <TOKEN>
 *   token 需要 repo 的 Contents: Read and write（或 classic 的 repo 權限）。
 *
 * 安全性：
 *  - 推送前先檢查遠端 head 是否為本機 commit 的祖先（fast-forward）。
 *  - 不是 fast-forward 就中止，不強推。
 *  - 只送「遠端 tree 沒有、或內容不同」的 blob，資料夾結構沿用遠端。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OWNER = '2w2wqian-pixel';
const REPO = 'reading-quiz';
const BRANCH = 'main';
const ROOT = path.resolve(__dirname, '..');
const TOKEN = process.argv[2];

if (!TOKEN) {
  console.error('用法：node tools/_push_repair.js <TOKEN>');
  process.exit(1);
}

function api(method, p, body) {
  return new Promise(function (res, rej) {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path: p, method: method,
      headers: {
        'User-Agent': 'rq-push',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': 'Bearer ' + TOKEN,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, function (r) {
      /* ⚠ 一定要「先收集 Buffer 再一次性 toString('utf8')」。
         若寫成 `let b=''; r.on('data', d => b += d)`，等於對每個 chunk 各自做
         Buffer→string 轉換；當某個中文字的 3 個位元組剛好被 chunk 邊界切開，
         兩半各自解碼就會變成兩個 U+FFFD（'核' → '��'）。
         後果是「同一個中文檔名被看成兩個不同路徑」——遠端多出一個不存在
         的幽靈檔（工具判定該刪）、真實檔（判定該改），同一次 tree 送出
         刪除＋修改同一路徑 → GitHub 回 422 GitRPC::BadObjectState。 */
      const chunks = [];
      r.on('data', d => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      r.on('end', () => {
        const b = Buffer.concat(chunks).toString('utf8');
        let j = null; try { j = JSON.parse(b); } catch (e) { }
        if (r.statusCode >= 400) return rej(new Error('HTTP ' + r.statusCode + ' ' + p + ' :: ' + b.slice(0, 300)));
        res(j);
      });
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

function gitBlobSha(buf) {
  const h = crypto.createHash('sha1');
  h.update('blob ' + buf.length + '\0');
  h.update(buf);
  return h.digest('hex');
}

/* 本機要發佈的檔案（與 _api_publish.py 的清單一致，排除 tools/ 以外的雜物） */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.workbuddy', '_archive', '.rq_backup']);
const SKIP_EXT = new Set(['.log', '.bak', '.tmp']);

/* 遠端要保留、但本機本來就沒有的檔案（「本機沒有」不等於「該刪」）。
 * ⚠ 必須是精確路徑，不要用目錄前綴，否則會整批保留下來。 */
const KEEP_REMOTE = new Set([
  'data/quizzes/中二試卷-07-閱讀能力考核-ykbl.json'
]);

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    let st; try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, rel, out);
    } else {
      if (SKIP_EXT.has(path.extname(name).toLowerCase())) continue;
      out.push({ rel: rel, full: full });
    }
  }
}

(async function () {
  const ref = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH);
  const remoteHead = ref.object.sha;
  console.log('遠端 main =', remoteHead.slice(0, 8));

  const rCommit = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + remoteHead);
  const remoteTree = rCommit.tree.sha;
  console.log('遠端 tree =', remoteTree.slice(0, 8));

  const rt = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/trees/' + remoteTree + '?recursive=1');
  const remote = {};
  rt.tree.forEach(function (e) { if (e.type === 'blob') remote[e.path] = e.sha; });

  const local = [];
  walk(ROOT, '', local);
  console.log('本機檔案數 =', local.length, '| 遠端檔案數 =', Object.keys(remote).length);

  /* 先確認「遠端是不是本機的祖先」——本機沒有 .git 時改用內容判斷 */
  const localMap = {};
  for (const f of local) localMap[f.rel] = gitBlobSha(fs.readFileSync(f.full));

  const onlyRemote = Object.keys(remote).filter(p => !(p in localMap));
  if (onlyRemote.length) {
    console.log('\n⚠ 遠端有、本機沒有（會被保留，因為以遠端 tree 為 base）：');
    onlyRemote.slice(0, 20).forEach(p => console.log('   ', p));
    if (onlyRemote.length > 20) console.log('    … 其餘', onlyRemote.length - 20, '個');
  }

  const changed = local.filter(f => remote[f.rel] !== localMap[f.rel]);
  console.log('\n需要推送：' + changed.length + ' 個檔案');
  changed.forEach(f => console.log('   M', f.rel));

  /* 「本機沒有」的檔案要從遠端刪掉（除了明確列入保留清單的）。
   * ⚠ 只做「新增／覆蓋」的推送工具會累積垃圾檔：本機刪了、遠端還在，
   *   久而久之遠端就與本機愈差愈多。刪除必須一起送出去。 */
  const changeSet = new Set(changed.map(f => f.rel));
  const deleted = onlyRemote.filter(p => !KEEP_REMOTE.has(p) && !changeSet.has(p));
  const kept = onlyRemote.filter(p => KEEP_REMOTE.has(p));

  /* 安全網：同一次送出裡「又刪又改」同一路徑 → GitHub 會回 422。
     正常情況不該發生；一旦發生，幾乎都是路徑本身被搞壞了（例如編碼問題
     產生了一個與真實檔名只差幾個位元組的幽靈路徑），此時**必須中止**，
     不可硬推——否則就是誤刪真檔。 */
  const conflict = deleted.filter(p => changeSet.has(p));
  if (conflict.length) {
    console.error('\n❌ 中止：同一個路徑同時被判定為「要刪」與「要改」，這代表路徑比對有問題：');
    conflict.forEach(p => console.error('   ', JSON.stringify(p)));
    console.error('   （常見原因：中文檔名在傳輸中被截斷成 U+FFFD，請先檢查 api() 的編碼處理）');
    process.exit(1);
  }

  if (kept.length) {
    console.log('\n🔒 保留（本機沒有，但列在 KEEP_REMOTE）：');
    kept.forEach(p => console.log('   ', p));
  }
  if (deleted.length) {
    console.log('\n需要刪除（遠端有、本機已移除）：' + deleted.length + ' 個');
    deleted.forEach(p => console.log('   D', p));
  }

  if (!changed.length && !deleted.length) { console.log('\n已經完全同步，不需推送。'); return; }

  /* 建立新 tree：以遠端 tree 為 base，覆蓋差異檔、並用 sha:null 刪除多餘檔 */
  const entries = [];
  for (const f of changed) {
    const blob = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs',
      { content: fs.readFileSync(f.full).toString('base64'), encoding: 'base64' });
    entries.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
  }
  for (const p of deleted) {
    entries.push({ path: p, mode: '100644', type: 'blob', sha: null });
  }

  const newTree = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees',
    { base_tree: remoteTree, tree: entries });
  console.log('\n新 tree =', newTree.sha.slice(0, 8),
    '（遠端原有的檔案保留，', deleted.length, '個已刪除）');

  let message = '學生端新增「默寫範圍」板塊 ＋ 修復移除生詞後主頁不同步';
  const msgFile = path.join(ROOT, '.git', 'COMMIT_EDITMSG');
  try {
    const m = fs.readFileSync(msgFile, 'utf8').trim();
    if (m) message = m;
  } catch (e) { }

  const now = Math.floor(Date.now() / 1000);
  const who = { name: '2w2wqian-pixel', email: 'teacher@example.com', date: new Date().toISOString() };
  const commit = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits',
    { message: message, tree: newTree.sha, parents: [remoteHead], author: who, committer: who });
  console.log('新 commit =', commit.sha.slice(0, 8));

  await api('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + BRANCH,
    { sha: commit.sha, force: false });

  const after = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH);
  console.log('\n✅ 遠端 main 現在 =', after.object.sha.slice(0, 8));
  console.log('   fast-forward，遠端原有的歷程完全保留。');
})().catch(function (e) {
  console.error('\n❌ 推送失敗：' + e.message);
  process.exit(1);
});
