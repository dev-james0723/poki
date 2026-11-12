# Poki 第二階段整合審查

> Historical pre-port review. The required clean-fork port was subsequently completed in d342e1e and installed for Sing. See [the current installation and multi-app results](native-multi-app-results-20261112.md). The limitations below describe the earlier candidate review.


第二階段可在包含現有本機前置功能的隔離副本整合；目前不可直接把候選 commit 套到已公開的乾淨 fork 分支。沒有安裝第二階段、重啟共用服務、操作手機或呼叫付費模型。

## 審查範圍

候選 `4710c0fa508f023d95d97b6a6432735a493da030` 以本機 `7e3df7c` 為基礎，加入 `run_workflow`、有限數字 `tap_sequence`、`run_app_action`、`choose_action` 及 AX query。審查副本另外保留當時 K1 原始碼快照及第一階段修復。它不是目前共用服務的精確最終版本，不能覆蓋之後 K1 的改動。

## 已重現及修復的問題

1. **局部 AX 結果被當作完整畫面。** 第一階段最終 checkpoint 重用新增拒收 `scope` 及不一致 `source_total`。測試確認 query 以外的 Loading 仍出現在完整批次報告。
2. **負面條件大小寫不一致。** workflow 條件會正規化，而 query 原先精確比對；`none:["loading"]` 可能漏掉畫面的 Loading。兩者現採用相同 NFKC、大小寫及首尾空白規則。
3. **預驗遺失跨欄驗證。** Zod → JSON Schema → Zod 會遺失 query refinement，可能先點擊、後發現 `query:{}` 無效。現於批次預驗保留原來 validator，測試確認前面的點擊亦不會送出。
4. **AX 快取與普通讀屏 signature 不一致。** 原先可能把未變畫面誤判為有變；兩條路徑現共用包含 foreground 及相同 flag 規則的 signature，並保留 revision、原生根畫面及時間資料。回歸測試確認第一次點擊後畫面未變時，後續依賴點擊不會執行。

另修正隔離整合測試的 discovery 預期：K1 另有 unlock 工具，所以整合版本為 full 70、default 32；獨立第二階段候選仍為 full 69。這不是現有 chat 已載入新工具的證據。

## 驗證

- 公開分支 AX／batch 聚焦測試：26/26 通過，包括第 4 項先失敗、修復後通過。
- 隔離整合 Rust：38/38 通過；使用獨立 Cargo target，沒有覆蓋現有 native binary。
- 首輪隔離整合 Node：486/488 通過；兩個失敗均為上述 K1 discovery 預期。修正後最終 **489/489 通過、0 失敗**（523 秒）。最終 131 檔 source manifest 在測試期間及完成後保持一致。
- 第二階段修復 patch 已通過原始候選 `git apply --check`。這只證明可套用，完整整合測試的適用範圍仍是本次快照。

全部為隔離軟件 fixtures；沒有讀取真實密碼或 Keychain credential、沒有付費 Jev 請求，亦沒有建立新的真機速度數據。

## 實際 fork 的限制

公開速度分支由 fork main `291a904` 乾淨建立，刻意沒有早前的本機私人歷史。第二階段依賴它尚未包含的 native session／warm HID 支援、speed tests、decision selector 及 gateway 模組。直接套用完整候選 patch 已實際檢查並失敗；不能靠 cherry-pick 本機歷史解決。

下一次整合必須逐項移植必要的通用前置功能，保持公開分支的乾淨歷史，重新測試。啟用時仍須協調 K1 安全窗口、更新並驗證 native helper 的 `native_tap_sequence` feature、重新連接客戶端發現工具，以及完成同一部手機的實測。現有軟件通過不代表已接近人類速度。

第一階段六次實測及真人自行計時比較另見速度報告：成功中位數 26.522 → 25.539 秒，觀察下降 3.7%；前後各 2/3 成功。真人三次合共約 2 秒，粗略差距仍約 38.3 倍。


## 保存及目前服務狀態

本輪通用修復與審查 patch 保存於公開速度分支的 `review/stage2-merge-fixes.patch`；它的目標是原始第二階段候選，並不是可直接套用公開 fork 的完整第二階段。完整本機 K1 快照及私人歷史均沒有推送。

最後以完整原生 Poki MCP 呼叫 status 成功：runtime 為 66 tools、原有 native build 2026-11-12T03:48:26.125Z。第一階段核心仍已載入；最後三檔維護 patch 尚未載入（已核對實際 source hashes），由 K1 擁有者安排安全窗口。沒有在對方等待實體 K1 回合時重啟服務。
