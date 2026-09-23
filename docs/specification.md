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

### 6.3 `noul` 判定のキャリブレーション問題（未解決、2026-09-23 調査）

`reflex-serve`（`Qwen/Qwen3.5-4B`）が返す `keepCall`/`keepResult` は、実運用・合成テストの両方で **`keepThreshold`（既定 0.5）を大きく上回る側に偏り、内容の新旧・要否をほとんど弁別できていない** ことが判明した。以下はその根拠と、未解決の論点。

#### 証拠 1: 実セッションでの `fallback_low_reduction` 連発

`.reflex/hook.log` の実例（いずれも `/compact` 実行）:

| 時刻 | messagesBefore | 候補数 | reductionRatio | 備考 |
|---|---|---|---|---|
| 2026-09-23 03:49 | 196 | (ログ修正前で未記録) | 0 | §7.2 のログ修正前のため per-call 内訳なし |
| 2026-09-23 04:03 | 60 | 17 | 0 | **17件全て `keep`**。`keepResult` は 0.562〜0.939 の範囲で、最低値でも閾値 0.5 を上回る |
| 2026-09-23 04:36 | 42 | 5 | 0.069 | 4件 `keep` + 1件 `drop_result`。閾値 0.25 未満で結局フォールバック |

3回とも「本当にそのセッションの内容が全部必要だったから」という可能性を排定できなかったため、証拠2の合成テストを実施した。

#### 証拠 2: 合成トランスクリプトによる意図的な陳腐化コンテンツの混入テスト

`compactMessages()`（`preserveRecentMessages: 2`）に対し、明らかに不要な重複・陳腐化コールを意図的に混ぜた合成トランスクリプト（同一 `ls src/` を3連続、バグ修正前後で内容が変わる `grep`、修正前の失敗テスト実行など計7件の `stale` ラベル + バグ修正 `Edit` や修正後のテスト実行など5件の `needed` ラベル、計12候補）を実際の `reflex-serve` へ投げた（テストスクリプトは使い捨てで `examples/` には残していない）。

結果: **12候補全てが `keep` 判定、`reductionRatio: 0%`**。

| id | tool | ラベル | keepResult |
|---|---|---|---|
| t1 | Bash (`ls` ×1) | stale | 0.798 |
| t2 | Bash (`ls` ×2) | stale | 0.755 |
| t3 | Bash (`ls` ×3) | stale | 0.755 |
| t4 | Bash (`grep`修正前) | stale | 0.818 |
| t5 | Edit (バグ修正) | needed | 0.798 |
| t6 | Bash (`grep`修正後) | stale | 0.818 |
| t7 | Bash (テスト失敗、修正前) | stale | 0.818 |
| t8 | Bash (テスト成功、修正後) | needed | 0.881 |
| t9 | Bash (`git status` ×1) | stale | 0.777 |
| t10 | Bash (`git status` ×2) | stale | 0.706 |
| t11 | Read (設定ファイル) | needed | 0.867 |
| t12 | Bash (`npm test`) | needed | 0.893 |

stale 系は 0.706〜0.818、needed 系は 0.798〜0.893 で、方向性としては needed がやや高いものの **0.798〜0.818 で完全に重なっており**、`keepThreshold` をどこに引いても stale/needed を安全に分離できない。

#### 証拠 3: `keepResult` が少数の離散値の使い回しに見える

`.reflex/hook.log` に記録された全 `keepResult`（22件、証拠1の後半2回分）を集計すると:

| 値 | 出現回数 |
|---|---|
| 0.562177 | 6 |
| 0.679179 | 5 |
| 0.705785 | 3 |
| 0.622459 | 2 |
| 0.754915 / 0.651355 / 0.592667 / 0.531209 / 0.5 / 0.468791 | 各1 |

全く別のセッション・別の質問文言・別のツール呼び出しにまたがって **小数点6桁まで完全一致する値** が繰り返し出現している。証拠2の合成テストでも同様に複数コールで値が一致していた（0.798 が t1 と t5、0.818 が t4/t6/t7 で一致）。これは内容ごとに滑らかに変化する連続確率というより、モデルが少数の離散的な自信度ティアのどれかを選んでいるだけで、質問対象の具体的な中身（stale か needed か）にはほとんど反応していない可能性を示唆する。証拠2で見えた「needed がやや高め」という弱い傾向も、内容理解の結果ではなくこの離散ティアの偶然の分布による可能性を排除できていない。

#### 証拠 4: ビルド鮮度・モデル再ロードの否定（交絡要因の切り分け）

証拠1（本番、プラグインキャッシュ経由）と証拠2（合成テスト、`src/` を `tsx` で直接実行）が同じロジックを比較しているか、また `reflex-serve` 側の再ロードが値を変えていないかを確認した。

- **ビルド鮮度**: `dist/compact.js`（2026-09-23 12:40:11）は `src/compact.ts`（12:39:57）より新しく再ビルド済みで、`~/.claude/plugins/cache/fast-jev-compaction-with-reflex/.../dist/compact.js` と `diff` で完全一致。証拠1・証拠2は同一ロジックを見ており、ビルドのズレによる交絡はない。
- **`reflex-serve` の再ロードなし**: `.reflex/reflex-serve.log` では 2026-09-23 12:42:05 に `Qwen/Qwen3.5-4B` を一度ロードしたきり、証拠1・証拠2に対応する全リクエスト（12:49〜14:20）は同一プロセス・同一ロード状態で応答している。モデルの再ロード・再コンパイルによる数値の揺れではない。
- **副産物の発見（`no adapter, no calibration file`）**: `docs/ARCHITECTURE.md:144` および `reflex/README.md:99` に明記の通り、このデプロイは `frozen Qwen3.5-4B, no adapter, no calibration file` で稼働している。`reflex/src/reflex/readout.py` の `Calibration`/`calibration_head.py`（質問の kind・log(選択肢数)・log(state tokens)・エントロピー・logit マージンから温度を予測する較正ヘッド）は **calibration.json が存在する場合のみ有効**（`engine.py` の `_sibling_calibration` 経由）であり、今回の構成では発火していない（`cal = Calibration()` のデフォルト、per-primitive 温度 1.0 の未較正状態）。つまり証拠3の離散値は温度較正の量子化アーティファクトではなく、**LoRA アダプタでこのタスク向けに一切ファインチューニングされていない素の instruct モデルが、ほぼ同一の state・似た質問文言に対して生 logits レベルで似た出力を返しているだけ**、というより単純な説明で足りる。

#### 未解決の論点・次のアクション候補

- ~~未検証: `reflex/src/reflex/engine.py` 等で `noul` の確率をどう計算しているか~~ → 証拠4で判明: `calibration_head.py` による温度較正は今回の構成では無効（`no adapter, no calibration file`）。離散値は較正の量子化ではなく、素の frozen モデルの raw logits がほぼ同一の state・類似の質問文言に対して似た出力を返す結果と考えられる。
- `keepThreshold` を単純に引き上げる対処は、stale/needed のティアが重なっている（証拠2）ため安全に機能しない可能性が高い。
- 切り分けが必要な代替仮説: (a) `Qwen/Qwen3.5-4B` 自体の能力不足（無較正・無アダプタの素のモデルでは尚更）、(b) `questionsFor`（`src/compact.ts`）の質問文言が判別しやすい表現になっていない、(c) 全コールに対して同一の完全な `state` を repeat して送る設計（§本節冒頭）が、個々のコールの相対的な重要度を判断させる情報として不十分。`reflex/README.md:275` にある `--adapter`/`--calibration` オプション（LoRA アダプタ + 較正ファイルを指定するモード）を試す余地は未検証。
- 現時点の結論: **この構成（`Qwen/Qwen3.5-4B` を無アダプタ・無較正のまま + reflex の `noul` 確信度をそのまま `keepThreshold` と比較する方式）は、コンパクションの要否判定として信頼性のある結果を返せていない。**

---

## 7. Claude Code Hook 統合 (`hooks/fast-jev.ts`, `hooks/hooks.json`)

### 7.1 Hook イベント
- **`session.compact`**:
  - Claude Code の自動 compaction 発生時にインターセプト（`hooks/hooks.json` は `./fast-jev.ts` の 1 モジュールのみを登録）。
  - `compactSession()` → `compact()`（`src/compact.ts`）を実行し、`reductionRatio` が `minReductionRatio`（既定 0.25）未満なら破棄して `next(event)`（組込み要約）へフォールバック。例外発生時も同様に catch 節から `next(event)` へ落ちる。
  - 同時実行を防ぐ専用ミューテックスは存在しない（`turn.complete` 側の `compacting` フラグのみ。§5.1 参照）。
- **`turn.complete`**:
  - `$.session.usage()` の `context.percent` を評価し、`compactAtPercent`（既定 60%）以上なら `$.session.compact()` を呼んで事前 compaction を発火。

### 7.2 発火ログ (`.reflex/hook.log`, `appendHookLog`)
- **実装箇所**: `hooks/fast-jev.ts` の `appendHookLog(fs, event)`。`$.fs.read`/`$.fs.write`（プロジェクト作業ディレクトリ相対）のみで実装され、Node の `fs` モジュールには依存しない。
- **ログ出力先**: `.reflex/hook.log`（NDJSON、1 行 1 イベント）。`.gitignore` に追加済みでコミット対象外。
- **記録タイミングと内容**:
  - `session.compact` ハンドラが実際に呼ばれた回（成功・閾値未達フォールバック・例外フォールバックの 3 通りすべて）: `{timestamp, event:"session.compact", verdict:"compacted"|"fallback_low_reduction"|"fallback_error", reductionRatio, messagesBefore, messagesAfter?, error?}`。`verdict:"compacted"` の回のみ `decisions: {id, tool, action, keepCall, keepResult}[]`（pinned 除く全候補）も付与し、どの tool call が `keep`/`drop_result`/`drop_call` されたかを事後に追跡できる。
  - `turn.complete` が実際に `$.session.compact()` を発火させた回のみ（閾値未達でスキップした回は記録しない、ノイズになるため）: `{timestamp, event:"turn.complete", verdict:"triggered_compact", contextPercent, compactAtPercent}`
- **失敗耐性**: `$.fs` の read/write がいずれも例外を投げても `appendHookLog` は内部で握りつぶし、compaction 自体には一切影響しない（best-effort ロギング）。
- 旧版のプライバシー保護監査ログ仕様（DEF-12、`session_id`/`request_id`/`duration_ms`/`error_code` の記録、`auditRetentionDays`/`auditRetentionMaxMb` によるログローテーション）は実装されていない。現状は上記の軽量な発火有無ログのみ。

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
| **DEF-12** | 発火ログ | `hooks/fast-jev.ts` (`appendHookLog`) | `.reflex/hook.log`（NDJSON）に compaction 発火の verdict を記録。トランスクリプト本文は含まない軽量版。 | 簡素化版が実在（詳細: §7.2） |
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
