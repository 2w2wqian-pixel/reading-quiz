# 閱讀理解練習站（Reading Quiz Station）

純靜態網站：老師上傳 Word 閱讀理解試卷 → 自動生成線上測驗 → 學生登入作答 →
可在文章上螢光標示、寫筆記、收集生詞 → 老師一次看到所有人的作答與學習痕跡。

可直接部署到 **GitHub Pages**，不需要任何付費服務。

---

## 1. 資料夾結構

```
reading-quiz/
├── index.html                     # 唯一入口（單頁應用，hash 路由）
├── assets/
│   ├── css/app.css                # 奶萌粉彩主題
│   └── js/
│       ├── lib/jszip.min.js       # 解壓 .docx 用（已內建，可離線）
│       ├── core/
│       │   ├── util.js            # DOM / 字串 / toast / modal / CSV
│       │   ├── crypto.js          # WebCrypto SHA-256（密碼雜湊）
│       │   ├── store.js           # IndexedDB（失敗自動降級記憶體）
│       │   ├── backend.js         # GitHub / Webhook / 隨站發佈 三種通道
│       │   └── docx-parser.js     # ★ .docx 解析與拆題
│       ├── ui/highlighter.js      # ★ 螢光筆 / 筆記 / 生詞本
│       ├── teacher.js             # 老師端
│       ├── student.js             # 學生端
│       └── app.js                 # 路由、首頁、設定頁
├── data/                          # 由 GitHub Pages 直接提供的靜態資料
│   ├── config.json
│   ├── roster.json                # 學生帳號（只存 salt:hash）
│   └── quizzes/
│       ├── index.json             # 試卷清單（老師端「發佈」時自動維護）
│       └── <quiz-id>.json         # 單份試卷
├── tools/apps-script.gs           # 免費收集端（Google Apps Script）
└── README.md
```

---

## 2. .docx 解析規則

解析器在**瀏覽器端**執行（不上傳檔案到任何伺服器）。
`.docx` 本質是 zip，程式用 JSZip 取出 `word/document.xml`，再依文件順序還原區塊。

| 規則 | 說明 |
|---|---|
| **R1 區塊順序** | 走訪 `w:body`，`w:p` 為段落、`w:tbl/w:tr` 為表格列；表格內的 `w:p` 另外收集，用於擷取文章。 |
| **R2 答案＝紅字** | 教師版答案文字使用 `<w:color w:val="FF0000"/>`，紅字即「正確答案／解析」。顏色可在上傳頁覆寫。 |
| **R3 選項符號** | 選項前是 Wingdings 符號：`Wingdings` F081→A、F082→B、F083→C、F084→D；`Wingdings 2` F06A→A、F06B→B、F06C→C、F06D→D（同字體往後一碼＝下一個字母）。 |
| **R4 題號** | 段落以 1～2 位數字開頭，且該行含「（n分）」或「？」→ 判定為題目。這可排除「評估重點 1掌握…」這類清單。 |
| **R5 分數** | 題幹內所有 `（n分）` 加總。 |
| **R6 文章** | 在「閱讀能力考材」與「－完－」之間，以「第一篇／第二篇」分段；長度 ≥ 25 字者視為正文，`[n]` 開頭者為注釋。 |
| **R7 能力標記** | 【整合】【引申】【評價】【解釋】 自題幹抽出，另存為標籤。 |
| **R8 版本對位** | 學生版與教師版「依題號對位」，把答案與解析合併回學生版。 |
| **R9 表格題** | 逐一比對學生版／教師版儲存格：內容不同者生成子題；教師版該格只有紅色勾選記號時，答案取該欄標題（如「肖像描寫」「錯誤」）。 |
| **R10 解析** | 「答案分析：」之後的文字視為解析；若沒有其他答案，解析即為答案。 |

### 實測結果（以 `K5E_QB_F2_R_T01.docx` 為例）

- 抓到 **16 題**、總分 **60 分**（與原卷一致）、**2 篇文章**（7 段 + 6 段）、4 則注釋
- 14 題答案自動帶入；第 2 題（組合式選擇題，正確選項在 Word 裡是圖形勾選記號）無法從文字判讀 →
  程式會明確標示「未能判讀正確選項，請手動勾選」，老師在編輯頁點兩下即可補上。

> Word 排版千變萬化，沒有任何規則能 100% 命中。因此**每一題、每一段文章都可以在編輯頁手動微調**，
> 這是刻意設計的安全網，不是缺陷。

---

## 3. 儲存與後端（三種通道，可並存）

| 用途 | 通道 | 說明 |
|---|---|---|
| **學生讀取試卷** | 隨站靜態檔 | 老師把 JSON 放進 `data/quizzes/`，GitHub Pages 直接提供，學生同源 `fetch` 即可，**不需 Token**。 |
| **老師寫入試卷／名冊** | GitHub Contents API | 用 PAT 在設定頁輸入；**Token 只存在老師自己瀏覽器的 localStorage，不寫死在程式碼、不上傳**。 |
| **學生提交作答** | Webhook（建議 Google Apps Script） | 學生不能用老師的 Token 寫 repo，所以要經另一個免費端點。 |
| **完全離線** | IndexedDB + JSON 匯出匯入 | 什麼都不設定也能用：學生匯出 JSON 傳給老師，老師匯入即可。 |

### 為什麼學生提交不直接寫 GitHub？
因為寫入 repo 必須要有 Token，而**把 Token 交給學生等於把整個 repo 的控制權交出去**。
Token 一旦外洩，任何人都能改你的檔案。所以學生的作答走免費收集端。

### 推薦的免費收集端：Google Apps Script
程式碼在 `tools/apps-script.gs`，設定步驟寫在檔案最上方：

1. 建立 Google 試算表 → 擴充功能 → Apps Script → 貼上程式碼 → 填 `SPREADSHEET_ID`
2. 部署 → 網頁應用程式 → 執行身分「我」、存取「任何人」
3. Web App 網址（`…/exec`）→ 貼到網站設定頁的「送出網址」
4. 試算表 → 檔案 → 共用 → 發佈到網路 → CSV → 該網址貼到「讀取網址」
   （Google 的 CSV 發佈允許跨網域讀取，老師端才讀得回來；`…/exec` 的 GET 會被 CORS 擋住）

其他可替代的免費收集端：Formspree（免費額度較小）、n8n、Cloudflare Workers + KV。
設定頁的「送出網址」其實接受任何能吃 `POST` + JSON 的端點。

### 更安全的做法（Token 相關）
1. 用 **fine-grained personal access token**：只授權**單一 repo**、只給 **Contents: Read and write**，並設定到期日。
2. Token 只貼在老師自己的電腦；用完可在設定頁一鍵清除。
3. 若學生共用電腦，登入後記得登出。
4. `roster.json` 只存 `salt:hash`，不含明文密碼——但這是**課堂工具的「防誤入」等級**，不是真正的身分驗證，請勿存放敏感個資。
5. 更嚴謹的長期方案：把 Token 放到 Cloudflare Workers 之類的邊緣函式當代理，前端完全不碰 Token。

---

## 4. 部署到 GitHub Pages

```bash
# 1. 建立 repo（或用 GitHub 網頁介面）
git init && git add . && git commit -m "init"

# 2. 推上 GitHub
git remote add origin https://github.com/<你的帳號>/<repo>.git
git push -u origin main

# 3. repo → Settings → Pages → Source 選 main / root
#    → 網址會是 https://<帳號>.github.io/<repo>/
```

> 網站首頁的網址要記得加 `/index.html#/` 或直接進 `https://…/index.html`。

### 使用流程
1. 老師開 `#/teacher` → 設定一組老師密碼
2. 「① 上傳試卷」拖入 .docx → 解析 → 自動進到編輯頁
3. 微調後按「**發佈到 GitHub**」（會寫入 `data/quizzes/<id>.json` 並更新 `index.json`）
4. 「④ 學生名冊」建立學生帳號 → 「發佈到 GitHub」寫入 `data/roster.json`
5. 學生開網站 → 登入 → 作答 → 提交後即可對答案
6. 老師在「③ 學生作答」看報表、手動給分、看每個人的標記與生詞

---

## 5. 已知限制

- 只支援 `.docx`；舊的 `.doc` 請先用 Word 另存為 `.docx`。
- 選擇題可自動計分；**文字題與表格題需要老師手動給分**（編輯頁可逐題輸入分數與評語）。
- 若要用「學生直接寫入 GitHub」的模式，必須另外架設 Token 代理，否則請用收集端或離線匯出。
- IndexedDB 無法使用時（隱私模式／部分瀏覽器）會自動降級為記憶體暫存，資料在關閉分頁後消失，請記得匯出備份。
