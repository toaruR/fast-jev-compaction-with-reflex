<!-- spec-doc:last-reviewed-commit=1db16fc691beb3046b3eaff6c04e7042ec142e61 reviewed-at=2026-09-22 -->

# 仕様書

本書は `fast-jev-compaction` のアーキテクチャ、公開 API、ローカル推論基盤（Reflex）、プロセス間通信（IPC）、サーキットブレーカー、文脈縮約、Claude Code hook 統合、防御レジストリの仕様を定義する。

---

## 1. 概要・システム構成

本プロジェクトは、Claude Code の会話履歴（Context）を監視し、トークン消費が閾値に達した際に不要な tool call / result を選別・縮約（compaction）する拡張ライブラリおよび hook である。
外部クラウド API（TypeSafe Jev）への依存および `TYPESAFE_API_KEY` を完全に廃止し、同梱のローカル推論基盤 **Reflex (`Qwen/Qwen3.5-4B`)** による完全オフライン推論を実行する。

```
Claude Code session.compact / turn.complete
  │
  ▼
hooks/fast-jev.ts ($.session.usage/.compact、$.http.fetch のみに依存、Node組込みモジュール非依存)
  │
  ▼
src/compact.ts (候補抽出、fitState による状態縮約、keepThreshold による採否適用)
  │
  ▼
src/request.ts (buildJevRequest/parseJevResponse、HTTP JSON リクエスト構築)
  │
  ▼ $.http.fetch → http://127.0.0.1:8008/v1/systemone
reflex-serve (reflex/src/reflex/server.py, FastAPI/uvicorn 常駐デーモン、Qwen/Qwen3.5-4B による System One 判定)
```

現行ブランチ（`feature/replace-jev-with-reflex2`、commit `1db16fc`）はこの HTTP デーモン方式のみを実装している。`hooks/fast-reflex.ts` / `src/reflex-client.ts`（stdio NDJSON 常駐子プロセス方式、`node:child_process` 等に依存）は、後述 §4.1 で扱っていた別系統の先行実装（並行ブランチ `feature/replace-jev-with-reflex`, commit `c391697`/`4d7b114`）のものであり、本ブランチの履歴には存在しない。

---

## 2. 公開 TypeScript API と契約 (`src/types.ts`, `src/client.ts`, `src/compact.ts`)

### 2.1 判定器インタフェース (`DecisionAsker`)

判定器は特定の推論エンジンに依存しない中立なインタフェースとして定義される。

```typescript
export type DecisionQuestions = Record<string, { type: 'noul'; instructions: string }>;
export type DecisionAnswer = { type: 'noul'; noul: number };
export interface DecisionResponse {
  model?: string;
  answers: Record<string, DecisionAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface DecisionAsker {
  ask(state: unknown, questions: DecisionQuestions): Promise<DecisionResponse>;
}
```

- `noul`: 各 tool call/result の「保持必要性確率（0.0 〜 1.0）」。
- `keepThreshold`: `noul >= keepThreshold`（既定値: 0.5）の場合はツール呼出しおよび結果を保持、下回る場合は削除・縮約対象とする。

### 2.2 設定オプション (`ReflexOptions`, `CompactOptions`)

- **`ReflexOptions`**:
  - `pythonCommand`: 実行する Python コマンド（未指定時は `python3` または `python` を自動探索）。
  - `bridgePath`: bridge スクリプトパス（既定値: `reflex/bridge.py`）。
  - `model`: 固定値 `'Qwen/Qwen3.5-4B'`。
  - `device`: `'auto' | 'cuda' | 'mps' | 'cpu'`（既定値: `'auto'`）。
  - `dtype`: `'bfloat16' | 'float16' | 'float32'`（既定値: `'bfloat16'`）。
  - `port`: HTTP serve モード時のポート番号（既定値: 8008）。
  - `requestTimeoutMs`: 要求タイムアウトミリ秒（既定値: 30000ms、許容範囲: 1000〜120000ms）。
  - `maxReflexStateChars`: Reflex 状態縮約の最大文字数（既定値: 16000文字、Unicode 境界保持）。
  - `permutations`: 位置バイアス低減のための置換数（既定値: 2、許容範囲: 1〜8）。
  - `restartLimit`: プロセスクラッシュ時の再起動上限回数（既定値: 1）。
  - `maxConsecutiveFailures`: サーキットブレーカー発火までの連続失敗回数（既定値: 3）。
  - `failureWindowMs`: 失敗回数を集計するスライディングウィンドウ幅（既定値: 300000ms / 5分）。
  - `maxAuditLogChars`: 監査ログの最大出力文字数（既定値: 4096文字）。
  - `auditRetentionDays`: 監査ログ保持日数（既定値: 30日）。
  - `auditRetentionMaxMb`: 監査ログ保持最大サイズ（既定値: 100MB）。

- **後方互換性と非推奨設定の拒絶**:
  - 旧 Jev 固有オプション（`apiKey`, `baseUrl`, `fetch`）が渡された場合、エラー `E_REFLEX_CONFIG_UNKNOWN` を投げて即座に拒絶する（外部通信や不正設定のサイレント無視を防止）。

---

## 3. Reflex ローカル推論基盤 & HTTP プロトコル (`reflex/src/reflex/server.py`)

### 3.1 動作仕様
- 常駐 HTTP デーモン（FastAPI/uvicorn、`reflex-serve` エントリポイント、既定ポート `8008`）として起動し、`POST /v1/systemone` で TypeSafe Jev 互換のリクエスト/レスポンス形式を提供する。
- `src/request.ts` の `buildJevRequest`/`parseJevResponse` が組み立てる JSON を、hook 側は `$.http.fetch`（`hooks/fast-jev.ts`）で叩くだけであり、Node の子プロセス管理・stdio トランスポートは介在しない。
- `apiKey`（`reflex-serve --api-key` または `REFLEX_API_KEY`）が設定されている場合のみ `Authorization: Bearer` を要求する。
- ヘルスチェック: `GET /health` -> `{"ok": true, "status": "healthy", "model": "Qwen/Qwen3.5-4B", "calibration": {...}, "strategy": "batched", "device": "cuda:0" 等}`。

### 3.2 既知の残存ファイル: `reflex/bridge.py`（本ブランチでは未使用・未追跡）
- リポジトリ作業ツリーに `reflex/bridge.py`（stdio 1行1要求 NDJSON 方式のブリッジ実装）が存在するが、`git ls-files` 上は本ブランチ（`feature/replace-jev-with-reflex2`）に追跡されておらず、`reflex/pyproject.toml` のエントリポイントからも参照されない。これは並行して存在した別ブランチ（`feature/replace-jev-with-reflex`, commit `c391697`/`4d7b114`）の作業ツリー残留物であり、現行の HTTP デーモン方式とは無関係。混乱を避けるため削除を検討する余地がある。

---

## 4. プロセス管理・トランスポート (`src/reflex-client.ts`)

- **安全なプロセス起動**:
  - `child_process.spawn` を `shell: false` で呼び出し、コマンドインジェクションを防止。
- **環境変数展開 (DEF-11)**:
  - プラットフォーム安全なホワイトリスト方式（`%USERPROFILE%`, `%LOCALAPPDATA%`, `%REFLEX_PYTHON%`, `${HOME}` など）のみを展開。未許可の環境変数参照は展開せずそのまま維持。
- **リクエスト多重化と相関**:
  - 各リクエストに一意の `id` を付与し、非同期応答とマップで相関。
- **タイムアウト監視とリソース解放**:
  - `requestTimeoutMs`（既定 30s）超過時は子プロセスに `SIGTERM`（Windows では `taskkill /pid /T /F`）を発行して強制終了し、`E_TIMEOUT` を返却。
- **エラーハンドリング**:
  - 異常終了、ストリーム切断、JSON パースエラー時は pending 状態のリクエストをすべて `E_SUBPROCESS_CRASH` 等で reject。

### 4.1 Claude Code Hook サンドボックスとの非互換性 — 本ブランチでは解消済み

- **旧問題（並行ブランチでの事象）**: 並行して存在した先行ブランチ（`feature/replace-jev-with-reflex`, commit `c391697`/`4d7b114`）の `hooks/fast-reflex.ts` は相対 import で `../src/reflex-client.ts` を取り込んでおり、`reflex-client.ts` が `node:child_process` 等の Node 組込みモジュールに依存していたため、`claude plugin validate` の「hooks モジュールから相対 import で辿れるファイルすべてについて Node 依存を禁止する」制約に抵触して失敗していた。hooks モジュールは DOM も Node も持たない専用サンドボックスで実行され、ホストとやり取りする唯一の窓口はディスパッチ引数 `$` である（`types/claude-code.d.ts` 冒頭コメント参照）。
- **本ブランチでの解決**: 現行ブランチ（`feature/replace-jev-with-reflex2`, commit `1db16fc`）の `hooks/fast-jev.ts` は `src/reflex-client.ts` を一切 import せず、`src/compact.ts` / `src/request.ts` のみに依存する。Reflex デーモンとの通信は `$.http.fetch(url, init)` によるプレーンな HTTP リクエスト（`http://127.0.0.1:8008/v1/systemone`）のみで行われ、`node:*` の import は存在しない。`npm run validate:plugin`（`claude plugin validate .claude-plugin/plugin.json`）は実際に**警告のみで成功する**ことを確認済み（2026-09-22 実行時点）。
- **実行時の前提条件**: `reflex-serve`（`reflex/src/reflex/server.py`, FastAPI/uvicorn）デーモンをユーザーが事前に起動しておく必要がある（`session.start` フックからの自動起動は未実装。`$.process.run` は起動から終了まで待つワンショット実行であり、バックグラウンドデーモンの起動には使えない）。デーモン未起動時は `$.http.fetch` が失敗し、`hooks/fast-jev.ts` の `session.compact` ハンドラの catch 節経由で Claude Code 組込み要約へフォールバックする。
- **未解決点**: `reflex-serve` デーモンの起動・生存管理（自動起動・ヘルスチェック・再起動）は本ブランチでも運用者の手動起動に依存しており、自動化されていない。

---

## 5. 障害時フォールバック — 本ブランチでは簡素化済み

### 5.1 現状: `src/circuit-breaker.ts` は本ブランチに存在しない
- 以前計画されていた 6 状態 FSM（`IDLE`/`STARTING`/`READY`/`REQUESTING`/`FAILED`/`DISABLED`）、5 分間スライディングウィンドウでの連続失敗検知（DEF-08）、`maxConsecutiveFailures` によるサーキットブレーカー発火は、`git ls-files src/circuit-breaker.ts` が空を返す通り、現行ブランチ（`feature/replace-jev-with-reflex2`）には未実装。子プロセスの起動・監視という前提自体が、`$.http.fetch` ベースの HTTP 通信（§1・§3 参照）に置き換わったことで不要になった。
- **実際の障害対応**: `hooks/fast-jev.ts` の `session.compact` ハンドラは `try/catch` のみで防御しており、`$.http.fetch` が失敗（reflex-serve 未起動・タイムアウト等）すれば即座に catch 節に落ちて `next(event)`（Claude Code 組込み要約）へフォールバックする。連続失敗のカウントや一定時間の遮断（OPEN 状態維持）は行わず、次回の compaction でも同じ試行を毎回リトライする。
- **再入防止のみ実装済み**: `turn.complete` ハンドラは `compacting` という単純な boolean フラグで、`$.session.compact()` 呼び出し中に同一ターンから再度呼ばれることだけを防ぐ。同一ターン番号での試行回数上限やアンチ停滞ロジック（旧 §5.3）は存在しない。

---

## 6. 文脈縮約・判定ロジック (`src/state.ts`, `src/compact.ts`)

### 6.1 Unicode 境界保持の文字数制限 (`fitReflexState`, DEF-04)
- Reflex の推論コンテキスト上限（8,192 token）に収めるため、渡される状態オブジェクトを最大 16,000 文字に切り詰める。
- **サロゲートペア保護**: 文字列切詰め時にサロゲートペア（絵文字や特殊漢字等）の途中で分断しないよう、Unicode コードポイント単位で安全に境界をスライスする。
- **優先順位付き縮約**:
  1. `Goal`（目標）: 最優先で保持
  2. `Pinned Messages`（ピン留め文脈）: 保持
  3. `Tool Summaries`: 順次保持
  4. `Recent History`: 上限文字数に収まる範囲で末尾から優先保持
- 状態超過により省略された tool call は、削除ではなく `action: "keep"` として扱い、誤削除を防止。

### 6.2 削減率検証 (`minReductionRatio`, DEF-14)
- 圧縮前後の文字数から削減率 `reductionRatio = 1 - (afterChars / beforeChars)` を算出。
- `reductionRatio < minReductionRatio`（既定 0.25）の場合は「圧縮効果不十分」とみなし、変更を破棄してフォールバックする。

---

## 7. Claude Code Hook 統合 (`hooks/fast-jev.ts`, `hooks/hooks.json`)

### 7.1 Hook イベント
- **`session.compact`**:
  - Claude Code の自動 compaction 発生時にインターセプト（`hooks/hooks.json` は `./fast-jev.ts` の 1 モジュールのみを登録）。
  - `compactSession()` → `compact()`（`src/compact.ts`）を実行し、`reductionRatio` が `minReductionRatio`（既定 0.25）未満なら破棄して `next(event)`（組込み要約）へフォールバック。例外発生時も同様に catch 節から `next(event)` へ落ちる。
  - 同時実行を防ぐ専用ミューテックスは存在しない（`turn.complete` 側の `compacting` フラグのみ。§5.1 参照）。
- **`turn.complete`**:
  - `$.session.usage()` の `context.percent` を評価し、`compactAtPercent`（既定 60%）以上なら `$.session.compact()` を呼んで事前 compaction を発火。

### 7.2 監査ログ — 未実装
- `docs/specification.md` の旧版は `.reflex/audit.ndjson` への構造化監査ログ（DEF-12: `timestamp`/`session_id`/`reduction_ratio`/`verdict` 等の記録、`auditRetentionDays`/`auditRetentionMaxMb` によるログローテーション）を仕様として記載していたが、`hooks/` と `src/` を `audit` で grep しても該当コードは一切見つからない。**現状は完全に未実装**。
- 実際に得られる実行時ログは `$.ui.log` / `$.ui.toast`（`notify()`）経由の一過性の UI 通知のみで、永続化されない。`decisionLogLines()` が生成する `decisions: t1:Read:keep/call=0.92/result=0.88 ...` 形式の行がその内容（`UI_LOG_MAX_CHARS=4096` でチャンク分割）。

---

## 8. 防御レジストリ (Defense Registry: DEF-01 〜 DEF-15)

このレジストリは複数ブランチにまたがる横断計画として書かれた経緯があり、行ごとに「本ブランチ（`feature/replace-jev-with-reflex2`）で実在するか」が異なる。実在しない行は状態欄に理由を明記した。

| ID | 防御項目 | 実装箇所 | 主な挙動・防御内容 | 本ブランチでの状態 |
|---|---|---|---|---|
| **DEF-01** | オフライン閉域性保証 | `src/client.ts`, `src/types.ts` | 外部 URL (`api.typesafe.ai`) への通信・API キー依存を全撤廃。 | 実在（`src/client.ts` あり） |
| **DEF-02** | モデル固定化 | `src/request.ts` (`DEFAULT_MODEL`), `src/types.ts` | `Qwen/Qwen3.5-4B` を既定モデルとしてリクエストに固定。 | 実在（実装箇所を `reflex/bridge.py` から訂正） |
| **DEF-03** | 決定論的リクエスト形式 | `src/request.ts` (`buildJevRequest`/`parseJevResponse`) | HTTP JSON `POST /v1/systemone`。NDJSON stdio ではない。 | 実在（IPC 方式は HTTP に変更済み。§3 参照） |
| **DEF-04** | サロゲートペア保護文脈縮約 | `src/state.ts` (`fitState`) | Unicode コードポイント境界で 16,000 文字制限。サロゲートペア分断防止。 | 実在 |
| **DEF-05** | 同時実行排他 | `hooks/fast-jev.ts`（`compacting` フラグ） | `turn.complete` からの `$.session.compact()` 再入のみ防止する簡易フラグ。専用ミューテックスではない。 | 簡素化版が実在（旧 `hooks/fast-reflex.ts` は不在） |
| **DEF-06** | 設定検証と非推奨オプション拒絶 | `src/compact.ts` | 旧 Jev 設定 (`apiKey`, `baseUrl` 等) を `E_REFLEX_CONFIG_UNKNOWN` で拒否。 | 要確認（現状と一致するか未検証） |
| **DEF-07** | コマンドインジェクション防止 | — | `spawn`/`child_process` は本ブランチのどこにも存在しない（HTTP 通信のみのため対象外）。 | **不在**（前提の子プロセス起動自体が無い） |
| **DEF-08** | 障害検知・隔離 | `hooks/fast-jev.ts`（`try/catch` → `next(event)`） | サーキットブレーカーではなく、失敗のたび毎回即フォールバックする単純な catch。連続失敗カウントなし。 | 簡素化版が実在（詳細: §5.1） |
| **DEF-09** | パッケージマニフェスト適合 | — | `scripts/validate-package-manifest.mjs` は `git ls-files` に存在しない。 | **不在** |
| **DEF-10** | 単一終了コード検証スクリプト | — | `scripts/reflex-release-gate.mjs` は `git ls-files` に存在しない。 | **不在** |
| **DEF-11** | 環境変数安全展開 | `hooks/fast-jev.ts` (`getApiKey`) | `REFLEX_API_KEY` のみを `$.env.get`/`$.settings.read` 経由で読む最小実装。ホワイトリスト展開機構ではない。 | 簡素化版が実在（旧 `src/reflex-client.ts` は不在） |
| **DEF-12** | 監査ログ | — | `.reflex/audit.ndjson` 等の永続ログは未実装。`$.ui.log`/`$.ui.toast` の一過性通知のみ。 | **不在**（詳細: §7.2） |
| **DEF-13** | プロセスクリーンアップ | — | 管理対象の子プロセス自体が存在しないため、プロセスツリー kill ロジックも対象外。 | **不在** |
| **DEF-14** | 最小削減率保証 | `src/compact.ts` (`reductionRatio`), `hooks/fast-jev.ts` | `reductionRatio < minReductionRatio`（既定 0.25）の場合は変更を破棄し安全フォールバック。 | 実在 |
| **DEF-15** | 不可逆マイルストーンタグ | Git repository | `reflex-m1-bridge`・`reflex-m2-supervisor`・`reflex-m3-hook`・`reflex-m4-default` タグが実在（`git tag -l 'reflex-*'` で確認）。 | 実在 |

---

## 9. エラーコード体系

- `E_PYTHON_NOT_FOUND`: Python 実行バイナリの探索失敗。
- `E_DEPENDENCY`: PyTorch, transformers 等の必須依存ライブラリの欠落。
- `E_MODEL_LOAD`: `Qwen/Qwen3.5-4B` のロードまたはチェックポイント読込失敗。
- `E_TIMEOUT`: `requestTimeoutMs` を超える推論応答待機タイムアウト。
- `E_SUBPROCESS_CRASH`: bridge プロセスの異常終了・クラッシュ。
- `E_REFLEX_CONFIG_UNKNOWN`: 非推奨または未知のオプション指定。
- `E_CIRCUIT_OPEN`: サーキットブレーカー発火による推論受付拒否。
- `E_INSUFFICIENT_REDUCTION`: 圧縮効果が `minReductionRatio` 未満。
