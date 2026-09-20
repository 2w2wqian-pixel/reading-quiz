# 閱讀理解練習站（Reading Quiz Station）

純靜態網站：老師上傳 Word 閱讀理解試卷 → 自動生成線上測驗 →
**學生在手機／iPad／電腦登入作答**（進度雲端同步，換裝置可接續）→
可在文章上螢光標示、寫筆記、收集生詞 → **老師即時看到誰交了、答什麼、標了什麼**。

部署在 GitHub Pages，雲端同步用 Firebase 或 Google Apps Script（都免費）。

---

## 1. 資料夾結構

```
reading-quiz/
├── index.html                     # 唯一入口（單頁應用，hash 路由）
├── assets/
│   ├── css/app.css
│   └── js/
│       ├── lib/jszip.min.js       # 解壓 .docx（已內建，可離線）
│       ├── core/
│       │   ├── util.js            # DOM / 字串 / toast / modal / CSV
│       │   ├── crypto.js          # WebCrypto SHA-256（密碼雜湊）
│       │   ├── store.js           # IndexedDB（失敗降級記憶體）+ 設定
│       │   ├── backend.js         # ★ 雲端層（Firebase / Apps Script / GitHub / 離線）
│       │   └── docx-parser.js     # ★ .docx 解析與拆題
│       ├── ui/highlighter.js      # ★ 螢光筆 / 筆記 / 生詞本
│       ├── teacher.js             # 老師端
│       ├── student.js             # 學生端
│       └── app.js                 # 路由、首頁、設定頁
├── data/                          # 由 GitHub Pages 直接提供的靜態資料
│   ├── roster.json                # 學生帳號（只存 salt:hash）
│   └── quizzes/
│       ├── index.json             # 試卷清單
│       └── <quiz-id>.json
├── tools/apps-script.gs           # 免費雲端（Google Apps Script + 試算表）
└── README.md
```

---

## 2. .docx 解析規則

解析器在**瀏覽器端**執行（檔案不上傳到任何伺服器）。
`.docx` 本質是 zip，用 JSZip 取出 `word/document.xml`，再依文件順序還原區塊。

| 規則 | 說明 |
|---|---|
| **R1** | 走訪 `w:body`：`w:p` 為段落、`w:tbl/w:tr` 為表格列；表格內的 `w:p` 另外收集，用於擷取文章。 |
| **R2 答案＝紅字** | 教師版答案用 `<w:color w:val="FF0000"/>`，紅字即「正確答案／解析」。顏色可在上傳頁覆寫。 |
| **R3 選項符號** | `Wingdings` F081→A、F082→B、F083→C、F084→D；`Wingdings 2` F06A→A、F06B→B、F06C→C、F06D→D（同字體往後一碼＝下一個字母）。 |
| **R4 題號** | 段落以 1～2 位數字開頭，且該行含「（n分）」或「？」→ 判定為題目（可排除「評估重點 1掌握…」）。 |
| **R5 分數** | 題幹內所有 `（n分）` 加總。 |
| **R6 文章** | 「閱讀能力考材」到「－完－」之間，以「第一篇／第二篇」分段；長度 ≥ 25 字為正文，`[n]` 開頭為注釋。 |
| **R7** | 【整合】【引申】【評價】【解釋】 自題幹抽出，另存為標籤。 |
| **R8** | 學生版與教師版「依題號對位」，合併答案與解析。 |
| **R9 表格題** | 比對兩版儲存格；教師版該格只有紅色勾選記號時，答案取該欄標題（如「肖像描寫」「錯誤」）。 |
| **R10** | 「答案分析：」之後的文字視為解析；若沒有其他答案，解析即為答案。 |

**實測**（`K5E_QB_F2_R_T01.docx`）：16 題全抓到、總分 60 分正確、2 篇文章（7 段＋6 段）、4 則注釋；
14 題答案自動帶入，第 2 題（組合式選擇，答案為圖形勾選）會明確標示「請手動勾選」。

> Word 排版千變萬化，沒有規則能 100% 命中，所以**每一題、每一段都能手動微調**——這是刻意設計的安全網。

---

## 3. 學生要怎麼跨裝置使用？（雲端同步）

**沒有設定雲端時，學生的作答只存在他自己的瀏覽器裡，你看不到。**
所以請在「老師專區 → ⑤ 資料與同步」設定**其中一種**雲端：

| 方案 | 即時性 | 免費額度 | 設定時間 | 適合 |
|---|---|---|---|---|
| **Firebase Realtime Database** | 即時（秒級） | Spark：1 GB 儲存／每月 10 GB 流量 | 約 8 分鐘 | 首選，反應最快 |
| **Google Apps Script + 試算表** | 寫入即時；讀取靠 CSV（Google 快取 0–5 分鐘） | 無流量上限 | 約 5 分鐘 | 不想註冊新服務 |
| GitHub repo JSON | 老師端才可寫 | 免費 | — | 只適合「試卷長期保存」 |

兩種方案在程式裡**共用同一套記錄模型**，所以功能完全一樣：
```
rec = { type, id, quizId, studentId, studentName, ts, key, payload }
type: 'submission'（已提交） | 'draft'（作答中進度） | 'register'（學生帳號）
id  : 'sub::<quizId>::<studentId>' / 'draft::<quizId>::<studentId>' / 'roster::<username>'
```

### 方案 A：Firebase（推薦）

1. 進 https://console.firebase.google.com → 新增專案（免費 Spark 方案即可）
2. 左側「建置 → Realtime Database」→ 建立資料庫（選「鎖定模式」再改規則）
3. 規則改成（只允許匿名登入者，擋掉路人）：
   ```json
   { "rules": { "rq": { ".read": "auth != null", ".write": "auth != null" } } }
   ```
4. 「專案設定 → 一般」→ 複製 **Web API Key**；Database 頁面複製 **Database URL**
   （`https://xxx.firebaseio.com` 或 `xxx-default-rtdb.asia-southeast1.firebasedatabase.app`）
5. 「建置 → Authentication → 登入方式」→ 啟用 **匿名**（學生不需要 Google 帳號）
6. 回到網站「⑤ 資料與同步」貼上 Database URL、API Key、
   自訂一組**班級代碼**（例如 `2A-CHI`）→ 按「啟用 Firebase 並測試」

> Firebase 的 Web API Key **本來就設計成放在前端程式裡**，不是秘密；
> 真正的防護是上面的資料庫規則。

### 方案 B：Google Apps Script + 試算表

**即時性（重要）**

| 環節 | 速度 |
|---|---|
| 學生按提交 → 資料寫進你的 Google 試算表 | **即時，沒有延遲** |
| 網站「③ 學生作答」報表顯示出來 | 通常 **0–5 分鐘** |

原因：網站讀取是讀「試算表發佈成 CSV」的網址，而 Google 對已發佈的 CSV 有快取。
程式會先嘗試即時讀取 `/exec?action=list`，但多數瀏覽器會因 CORS 擋住而改走 CSV。
報表頁的徽章會直接告訴你這次的資料是「雲端即時」還是「CSV 快取」。

**等不及的時候**：設定頁填「試算表網址」後，報表頁會有「直接開試算表（最即時）」按鈕；
或勾選「每 45 秒自動更新」讓它自己刷新。**需要秒級即時請改用 Firebase。**

設定步驟：程式碼在 `tools/apps-script.gs`，步驟也寫在檔案最上方：

1. 新增 Google 試算表，從網址複製 `SPREADSHEET_ID`
2. 試算表 → 擴充功能 → Apps Script → 貼上程式碼 → 填入 ID
   → 填 `CLASS_CODE`（班級代碼）與 `WRITE_KEY`（選填，防止路人亂寫）
3. 執行一次 `setup()`
4. 部署 → 網頁應用程式 → 執行身分「我」、存取「任何人（含匿名）」→ 複製 `/exec` 網址
5. 試算表 → 檔案 → 共用 → 發佈到網路 → **Data** 工作表 → CSV → 複製網址
6. 兩個網址貼到網站「④ 學生作答收集端」

> `/exec` 的 GET 會被 CORS 擋住，程式會自動改用 CSV 讀回（Google 允許跨網域讀取 CSV）。

---

## 4. 註冊邏輯

三種模式，可在「⑤ 資料與同步 → ② 學生註冊方式」切換：

1. **自助註冊（建議）**：學生在登入頁選「第一次使用・註冊」，填
   **姓名 ＋ 自選帳號 ＋ 密碼 ＋ 班級代碼** → 帳號寫進雲端名冊
   → 「④ 學生名冊」立刻出現 → 學生在任何裝置用同一組帳號密碼登入，
   進度與提交結果都跟著帳號走。
2. **老師建立**：老師在名冊頁手動新增（可關閉自助註冊）。
3. **只放 GitHub**：老師把 `data/roster.json` 推上 repo，學生讀取（唯讀、不能自助註冊）。

密碼只存 `salt:hash`（SHA-256），不存明文。這是**課堂工具的「防誤入」等級**，
不是真正的身分驗證，請勿存放敏感個資。

---

## 5. 作答進度怎麼存？

- 每次作答變動 → 存本機 IndexedDB（離線也安全）
- 每 20 秒（或按任何一題後滿 20 秒）→ 同步到雲端一次
- 關閉分頁／跳頁 → 用 `sendBeacon` 強制補送一次
- 下次登入同一份試卷 → 自動接續，`「已接續上次的進度（N 題已作答、M 處標記）」`
- 提交後清除雲端草稿

---

## 6. 老師看得到什麼？

「③ 學生作答」：

- 統計卡：作答人次、平均分、平均正確率、平均用時
- 明細表：每位學生的得分、正確率、用時、**標記數**、**生詞**
- **尚未提交（N / M 人）**：直接列出還沒交的學生
- 按「查看」→ 逐題看學生作答／參考答案／解析，
  可手動給分與寫評語（學生看得到），
  下方列出該學生的**螢光標示＋筆記**、**不懂的詞語**、**篇章筆記**
- 可匯出 CSV / JSON

---

## 7. 部署

```bash
git init -b main && git add . && git commit -m "init"
git remote add origin https://github.com/<帳號>/<repo>.git
git push -u origin main
# repo → Settings → Pages → Source: main / root
# 網址：https://<帳號>.github.io/<repo>/
```

### 使用順序
1. `#/teacher` → 設定老師密碼
2. 「⑤ 資料與同步」→ 設定 Firebase 或 Apps Script → 測試連線
3. 「② 學生註冊方式」→ 開放自助註冊、設班級代碼
4. 「① 上傳試卷」拖入 .docx → 解析 → 微調 → 「發佈到 GitHub」（同時會寫入雲端）
5. 把網址 + 班級代碼給學生 → 學生註冊 → 作答
6. 「③ 學生作答」看報表與標記

---

## 8. 已知限制

- 只支援 `.docx`；舊的 `.doc` 請先另存新檔。
- 選擇題自動計分；**文字題與表格題需老師手動給分**。
- Apps Script 方案的讀取走 Google CSV 快取，延遲 0–5 分鐘；Firebase 則是即時。
- IndexedDB 不可用時會降級為記憶體暫存（關掉分頁就消失），請記得匯出備份。
- Firebase 免費方案若長時間超量會停擺；一個班級的用量遠低於門檻。
