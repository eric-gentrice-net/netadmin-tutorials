# netadmin-tutorials

「網管小學堂：接線大作戰」的反向工程重建版。原站 <https://netadmin-school.milifun.net/> 是一個單一 HTML 檔的校園網路管理闖關遊戲，附有講師開班、學員同步進度的雲端功能。本專案把原站取回、拆成可維護的檔案結構，並依前端的呼叫方式重新實作後端 API，作為後續改作成自有版本的基礎。

## 來源與授權

- 原作者：辛文義（米立方智慧科技），© 2026。
- 程式碼：MIT 授權。
- 教材內容（關卡文字、知識卡、情境、提示）：[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-Hant)。改作後須標示來源、不得商業使用、以相同條款釋出。
- 後端 API（`api/`）為本專案依前端介面重新撰寫，原站後端程式碼並未公開。

詳見 [LICENSE](LICENSE)。

## 目錄結構

```
original/index.html   原站 2026-10-15 取回的單檔原件，不要修改，供對照用
web/                  拆檔後的前端（純 HTML + CSS + 原生 JS，無框架、無建置步驟）
  index.html          頁面骨架
  css/style.css       樣式（含深色模式變數）
  js/app.js           遊戲邏輯、關卡資料、雲端同步、講師總表
api/                  Cloudflare Worker：同時提供靜態網頁與 /api/*
  src/index.js        API 實作（KV 儲存）
  test/api.test.mjs   以記憶體 KV 模擬的整合測試（node 直接執行）
  wrangler.toml       Worker 設定
  .dev.vars.example   本機開發用環境變數範本
```

## 前端

純靜態，不需要建置。直接用任何靜態伺服器開 `web/` 即可：

```sh
cd web && npx serve .      # 或 python -m http.server
```

- 以 `file://` 開啟或沒有後端時，自動退回單機模式，進度只存 localStorage。
- 網址加 `?teacher` 進入講師總表；`?join=班級代碼` 直接帶出加入班級表單。
- `#rec=...` 可回放一局（講師總表「看每一步」用）。

## 後端 API

Cloudflare Worker + KV。原站的前端註解指出其後端即為 Worker，本實作沿用同樣架構。

### 部署

```sh
cd api
npm install
npx wrangler login
npx wrangler kv namespace create DB        # 把回傳的 id 填入 wrangler.toml 的 kv_namespaces.id
npx wrangler secret put TEACHER_SECRET     # 講師開班密碼
npm run deploy
```

部署後同一個網址同時提供網頁與 API，不需另外設定 CORS。

### 本機開發

```sh
cd api
cp .dev.vars.example .dev.vars            # 填入 TEACHER_SECRET
npm run dev                               # http://localhost:8787
npm test                                  # 不需 wrangler，直接以 node 跑 API 測試
```

> 若 `wrangler dev` 在 Windows 上出現「access violation in the runtime」，是 workerd 執行檔與系統環境的相容問題，與專案設定無關。可改用 `npm test` 驗證 API 邏輯，或在 WSL 內執行 `wrangler dev`。

### 介面一覽

學員端（除 join 外皆需 `Authorization: Bearer <學員 token>`）：

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/join` | `{code,name,resume?}` → `{token,code,name,className,resume,cfg,school}`。同名已存在回 409 並附 `need:"resume"`，復原碼錯回 403 |
| GET | `/api/me` | `{lv:{關號:星數},cd:[知識卡],className,resume,cfg,school}` |
| PUT | `/api/me/school` | `{school}` 設定學員自己學校的參數，傳 `null` 清除 |
| GET | `/api/saves` | `{saves:{關號:{cur,done}}}` 各關存檔 |
| POST | `/api/event` | `{events:[...]}` 一次最多 100 筆；事件型別 `open/test/time/win/card/save/sync` |

講師端（需 `Authorization: Bearer <講師金鑰>`，開班除外）：

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/class` | `{secret,name,code?,cfg?}` → `{code,name,key}`。secret 須等於 `TEACHER_SECRET` |
| GET | `/api/class/:code` | `{name,cfg,now,students:[{id,name,resume,cards,last_seen,cur_lv,cur_at,school,lv:{關號:{s,a,ms,h,w}}}]}` |
| PUT | `/api/class/:code` | `{cfg}` 更新班級的學校網路設定 |
| GET | `/api/class/:code/student/:id/save/:lv` | `{cur,done}` 學員該關的操作紀錄 |
| DELETE | `/api/class/:code/student/:id` | 移除學員，連同存檔與 token |

欄位意義：`s` 星數、`a` 測試次數、`ms` 累計操作毫秒、`h` 提示次數、`w` 是否過關。

### KV 鍵值配置

```
class:{CODE}          班級 {code,name,key,cfg,created,nextId}
stu:{CODE}:{id}       學員紀錄與各關統計
saves:{CODE}:{id}     學員各關存檔 {關號:{cur,done}}
name:{CODE}:{name}    名字 → 學員 id（名字不分大小寫、去多餘空白）
tok:{token}           學員 token → {code,id}
```

每位學員只寫自己的鍵，講師只讀取與刪除，因此 KV 的最終一致性在課堂規模下足夠。若日後需要跨學員的交易或大量並行寫入，可改用 D1 或 Durable Objects。

## 後續改作

- 關卡資料與教材文字集中在 `web/js/app.js`，`DEFAULT_SCHOOL`、`LEVELS`、`ROAD`、`CARDS` 是主要進入點。
- 版面變數在 `web/css/style.css` 開頭的 `:root`。
- 改作教材內容時請保留原作者標示並沿用 CC BY-NC-SA 4.0。
