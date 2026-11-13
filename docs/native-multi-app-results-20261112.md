# Poki 第二階段載入及多 app 實測

第二階段前置移植已完成並推送 fork，本機共用服務及 Sing native helper 已更新。今次除計算機準備檢查外，正式前後比較用了設定、時鐘及備忘錄。數據顯示個別操作改善、個別變慢，尚未證實穩定全面加速。

## 真機結果

同一部 iPhone 15 Pro Max、RemotePairing、相同原生 `batch_commands` 操作及最終完整即時 AX checkpoint。每個 app 每個版本各一次，共六次指定計時流程，全部驗證完成。啟動 app、返回起點、捲動及清空自建測試草稿屬準備，不計入下表；模型思考時間亦不計。工具呼叫及完整回傳均計入。

| 操作 | 更新前 | 更新後 | 當次觀察 |
|---|---:|---:|---|
| 設定：General → Keyboard，確認 Keyboards | 3.358 秒 | 3.101 秒 | 約短 7.7% |
| 時鐘：Timers → Stopwatch，確認 Start | 4.495 秒 | 7.484 秒 | 約長 66.5% |
| 備忘錄：空白自建草稿 → 56 字英中混合文字，讀回驗證 | 17.256 秒 | 11.783 秒 | 約短 31.7% |

這是探索性各一次樣本，不是中位數、p95、可靠性資格測試或所有 apps 的保證。備忘錄的填字步驟本身只由 10.768 秒變為 10.475 秒；大部分當次差額來自最後 AX checkpoint 由 6.472 秒變為 1.294 秒，不能把全部差額歸因於程式優化。

沒有啟動計時器、秒錶或鬧鐘，沒有發送／分享內容，沒有改設定開關。只建立及重用一張標示為「Poki speed test」的測試備忘錄，完成後保留。舊版第一次填字的原生回報為 clipboard snapshot unavailable、clipboard restored false；新版回報 complete／restored true。這是原有剪貼簿最佳努力還原機制的回報，本輪沒有改弱或跳過它。

## 真人參考

James 明確確認：設定及時鐘兩個流程各做三次，共六次合計約 5 秒，即混合平均約 **0.833 秒／次**。沒有分別提供兩個 app 的人工時間。

Poki 更新後這兩個導航各一次，混合平均 **5.293 秒／次**，與上述自行計時參考粗略相差 **6.35 倍**，仍未達人類速度。兩邊樣本數不同、沒有儀器配對計時；不能將這個比例分配到單一 app，亦不能套用到備忘錄。較早計算機的約 38.3 倍差距是不同任務，不能用來宣稱本輪已由 38 倍改善至 6 倍。

## 十幾秒額外延遲的定位

在載入新程式之前，同一個舊版本的無輸入 `batch(wait(0))` 已只需 24／19ms，內部 step 為 7／8ms；單獨 wait(0) 為 51ms。此前的 12–18 秒控制測試延遲沒有穩定重現。兩輪之間 host permission profile 及並行工作狀態有變，不能單憑時間差宣稱已找到唯一歷史原因或是新版消除了它。

已經先失敗、修復後通過地重現一個真實排隊問題：純讀取批次可能取得跨裝置輸入鎖；在指定裝置的輸入批次加入 wait，也可能令鎖擴大到所有手機。現在純讀取批次走原有有上限的 read admission，混合批次只由輸入步驟決定裝置鎖；不明或多裝置輸入仍保留全域仲裁。同 session 順序、取消及未知輸入保護保留。

新版把計時放入內容收據，避免 host 丟掉 `_meta` 後看不到資料。收據包括 service／dispatch、session queue、device resolution、lock wait，以及部分 native／AX 階段。早期錯誤保留原文，另附 `diagnostic_only` 計時；它不證明任何輸入結果。階段有父子包含關係，不能相加。

| 更新後操作 | 呼叫總耗時 | daemon service | 服務外差額 | 排隊 |
|---|---:|---:|---:|---:|
| 設定 | 3101ms | 3095ms | 6ms | 0.07ms |
| 時鐘 | 7484ms | 7468ms | 16ms | 0.12ms |
| 備忘錄 | 11783ms | 11775ms | 8ms | 0.14ms |

所以今輪三項並沒有十幾秒耗在服務外層。時鐘的 native requests 合計約 7.45 秒，其中 AX 約 5.32 秒、input 約 2.13 秒；備忘錄 native input 約 10.47 秒，最後 AX 約 1.29 秒。當下主要成本已定位於 native 裝置請求／讀屏與文字填入路徑。文字路徑包含欄位檢查、剪貼簿快照／還原及讀回驗證；快照與 PULL 各有最多八秒的界限，但本輪沒有細分其內部時間，不能直接把整個十秒指定給其中一項。

準備階段亦有一次 45 秒找按鈕失敗（未送出輸入）、10 秒 AX 超時，以及重連後 2.131 秒成功讀屏。另一次計算機嘗試 22.473 秒回傳錯誤、沒有 step receipt，同時共用 daemon 曾被重載；沒有重播輸入，亦沒有計入上述配對流程。不能只憑六次指定流程成功，宣稱所有準備及整體可靠性已通過。

## 本機更新及 K1 交接

本輪取得 K1 明確維護窗口及 source write lease。正常停止 watcher／唯一舊 daemon，逐檔核對及原子安裝 12 個 runtime source 檔案與新 native binary，再以同一 token、state、port 56138 啟動及恢復 watcher 採用。

- 載入時 daemon：37438 → **86576**；Sing helper：56249 → **86926**。
- Native build ID：`a2e7de8f74fd7995e91fe57d63f990d455240623d68cd4b47097a0fee0b1a3ed`。
- Native binary SHA-256：`aac9085ed51fbc4f01bc155d7fbf53db5072be925455773480de72e5cbffb455`。
- 真機 AX 回報包含 `native_tap_sequence`；原生 status 回報 runtime 70 tools、ask-human。乾淨公開分支為 69 tools，K1 本機另有一個工具。
- 核對保留 19 個 K1 source 檔、5 個 private configuration 檔、配對與同一 token。現有 K1 UNCERTAIN／UNSENT／未關閉記錄及零 Send claim 保留；正常 shutdown 可新增 uncertain event，沒有清除或重播。
- 沒有改 `stream.rs`／InputMedia 的 AV 生命週期，沒有手動重啟 James17 helper。該 helper 仍為舊 build，已向 K1 擁有者說明；本輪硬件驗證範圍是 Sing。

完成後已經以原生 MCP 釋放 Sing lease，回報 native input resources released=true；source write lease亦已釋放，K1 receiver 保持停用，正式交回 K1 chat，由它自行核對再啟用。最後 Sing occupied=false；James occupied=true 後獲 K1 擁有者確認是它接手核對的新租約，並已自行釋放。交還後本 chat 沒有再操作手機或重載服務。

全域 Codex 註冊仍指向本機 `src/stdio.mjs`，`POKI_MCP_TOOLS=all`，獨立 watcher 保留。現有 chat 未熱載入四個新增工具名，需要正常 MCP client reconnect；沒有為此重啟整個 Codex 或中斷其他 chat。這六次真機比較全程用現有完整原生 Poki MCP 的批次、鍵盤、觸控及讀屏，執行更新後的 dispatcher/helper。新增 `run_workflow` API、數字 burst、Shortcut 及外部 Jev 並非全部已經真機資格測試；沒有付費模型呼叫。

## 軟件驗證及保存

- 公開分支完整 Node：415/415 通過（最後 diagnostic-only 錯誤收據新增前）。
- 最後診斷／protocol／remote identity：44/44 通過。
- 裝置明確綁定、取消及 workflow：73/73 通過。
- 保留 K1 功能的本機隔離整合：162/162 通過。
- Rust：38/38 通過；optimized release 本機編譯成功，沿用未修改的 pinned idevice `89702099f4d7552f704f93b4526756abda319ceb` 及其既有 MIT notice，沒有新依賴。

原始碼已推送 `dev-james0723/poki` 的 `dev/native-mcp-speed-20261112`，移植 commit `d342e1e`；[PR #2](https://github.com/dev-james0723/poki/pull/2) 保持 draft。沒有帶入私人 K1 source 或較早本機 commit 歷史。

四個 GitHub CI jobs 均未啟動，annotations 一致顯示帳戶因 billing issue 被鎖；不是已執行的測試失敗。沒有更改付款／帳戶設定或聲稱 CI 綠燈。已完成本機檢查，沒有 merge main、發佈 release 或 dispatch macOS build。

用量：未有可核實 token／費用紀錄。
