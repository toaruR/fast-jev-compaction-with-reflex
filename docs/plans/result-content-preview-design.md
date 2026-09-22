# 判定モデルに tool result の中身を見せる設計 (ツイート批判②の解消)

## 1. 課題

`src/state.ts` の `resultNote(call)` は判定対象の全 tool call について常に次の形式のみを状態に載せる。

```
ok, 5238 chars (omitted)
```

`result_${id}` の質問文（`src/compact.ts` の `questionsFor`）は「この tool call のフル出力を verbatim で残す必要があるか」を聞いているにもかかわらず、判定モデルはその出力の中身を一切見せられていない。判定材料は tool 名・input・文字数のみで、実質「call の見た目」から結果の要否を当てずっぽうで推測している。これが誤って必要な結果を drop し、アシスタントが同じ調査をやり直す劣化ループを招く、というのがツイート指摘②の要旨。

## 2. 目的・非目的

- **目的**: `result_${id}` の判定に、実際の出力内容から得た限定的だが本物のシグナルを与える。
- **非目的**:
  - フル出力を常に送ること（それは圧縮の意味を無くす）。
  - `keepThreshold` の意味論、`CallDecision`/`CallAction` の形、リクエスト JSON スキーマを変えること。
  - ツイートの他の指摘（①③④⑤⑥）に対応すること — 別課題として扱う。
  - `maxStateTokens` を超過してよくすること — 既存の安全性（収まらなければ縮約を続け、最終的に収まらなければ例外を投げる）は維持する。

## 3. 設計

### 3.1 `ToolCall` に実際の結果本文を持たせる

`src/state.ts` の `collectToolCalls()` は現在 `resultChars`（文字数）だけを保持し、本文 `found.result.text` を捨てている。`src/types.ts` の `ToolCall` に `resultText: string` を追加し、`collectToolCalls()` で格納する。既にメモリ上にある `Message` の参照を持ち回すだけなので追加コストはない。

### 3.2 `resultNote` → `resultPreview`: head/tail プレビュー化

`abridge()`（メッセージ本文の要約に既に使っている head/tail 切り詰め）と同じ考え方を結果本文に適用する。

```ts
function resultPreview(call: ToolCall, headChars: number, tailChars: number): string {
  const status = call.isError ? 'error' : 'ok';
  if (headChars + tailChars === 0) {
    // 既存挙動そのもの（フォールバック床）
    return `${status}, ${call.resultChars} chars (omitted)`;
  }
  const body = abridge(call.resultText, headChars, tailChars);
  return `${status}, ${call.resultChars} chars: ${body}`;
}
```

- **pinned な call には適用しない**: pinned call は常に `keep` 確定で `result_${id}` の質問自体が飛ばない（`compact()` は `candidates = calls.filter(c => !c.pinned)` のみを判定にかける）。判定に使われないプレビューへ文字数を割くのは純粋な無駄なので、pinned は常に `headChars=0, tailChars=0`（＝現行の素っ気ない note）のままにする。
- **短い結果はフル表示**: `abridge()` は `head+tail+40` 以下ならそのまま全文を返す仕様を流用するので、小さい tool result（多くの `Bash` 出力等）は自然に全文がプレビューに載る。

### 3.3 `fitState` の段階的縮約にプレビュー予算を組み込む

現状 `fitState` は `INPUT_CHARS = [1000, 200, 60]` の3段階で tool input を切り詰めながら state 全体のトークン予算に収まるかを試す（`rebuild(inputChars)` → `fits()`）。これと並走する形でプレビュー予算のカスケードを追加する。

```ts
const RESULT_PREVIEW_CHARS = [
  { head: 400, tail: 150 }, // stage 0: INPUT_CHARS[0] と対
  { head: 120, tail: 40 },  // stage 1: INPUT_CHARS[1] と対
  { head: 0, tail: 0 },     // stage 2: INPUT_CHARS[2] と対 = 完全に現行挙動
] as const;
```

`historyEntries()` に `previewChars: { head: number; tail: number }` 引数を追加し、`rebuild(inputChars, previewChars)` として `INPUT_CHARS` と同じインデックスで同時に渡す。3段階を試しても収まらない場合、以降の縮約段（長文 abridge → 古いメッセージの折り畳み → `compactCall()` による1行圧縮 → 古いメッセージの間引き → call run の併合）は変更不要でそのまま流用する。`compactCall()`（最終手段の1行形式）は元々 result 内容を含めない設計なので影響を受けない。

結果として：
- 予算に余裕があるセッションほど手厚いプレビューが得られる。
- 予算が厳しいセッションでは自動的に stage 2（プレビュー無し = 現行の `resultNote` と完全一致）まで縮約され、**最悪ケースの安全性・既存の例外送出条件は一切変わらない**。

### 3.4 `STATE_CONTEXT` の文言更新

現行:

> "...tool outputs are replaced by a short `result` note and long texts may be abridged... Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file."

これを「`result` フィールドには実際の出力の head/tail プレビューが入っている（入らない場合のみ短い note）ので、それを根拠に判定してよい」という趣旨に更新する。副次的に、ツイート指摘⑥（"re-run すればいい" という言い訳のみで中身を見せていない点への皮肉）への反論にもなる — 今後は「中身を見た上でなお re-run 可能」という主張になる。

### 3.5 影響範囲まとめ

| ファイル | 変更 |
|---|---|
| `src/types.ts` | `ToolCall` に `resultText: string` を追加 |
| `src/state.ts` | `collectToolCalls` で `resultText` を格納／`resultNote`→`resultPreview` に改名・拡張／`historyEntries`・`fitState` にプレビュー段カスケードを追加／`STATE_CONTEXT` の文言更新 |
| `src/compact.ts` | 変更不要（`questionsFor` の instructions 文言は据え置き、または軽微な追記のみ） |
| `hooks/fast-jev.ts` | 変更不要 |

### 3.6 コスト面のトレードオフ（明示）

プレビュー分だけ `state` が肥大化し、`batchCalls()` が1リクエストに詰め込める tool call 数が減って `requests`（HTTP 往復）が増えうる。これはツイート指摘⑤（キャッシュ書き換えコスト）と同方向のコストを追加で払うことになるが、②の誤判定を減らす方が優先度が高いという判断。プレビュー予算を小さめ（数百文字オーダー）に抑え、pinned には適用しないことで最小化する。

## 4. テスト計画

`tests/fast-jev-compaction.test.ts`（state fitting 節）に追加:
- 非 pinned call の `result` フィールドに実際の本文の head/tail プレビューが入ること。
- pinned call の `result` フィールドは従来通り `"ok, N chars (omitted)"` のままであること。
- head+tail 以下の短い結果はプレビューに全文が入ること。
- 予算超過時、プレビューが段階的に縮小し、最終的に `head:0,tail:0`（現行と同一の note）に収束すること。
- 巨大履歴で例外が投げられる条件（`throws when the history cannot be fitted`）が今回の変更前後で変わらないこと。

## 5. 実装済み (2026-09-22)

設計通りに実装した。`src/types.ts`（`ToolCall.resultText`）、`src/state.ts`（`resultPreview`、`historyEntries`/`fitState` へのプレビュー段カスケード、`STATE_CONTEXT` 文言更新）を変更し、`tests/fast-jev-compaction.test.ts` にプレビュー内容・pinned除外・段階遷移のテストを追加。`npx tsc --noEmit`・`npm run typecheck:hooks`・`npx vitest run`（32/32）・`npm run validate:plugin` すべて成功を確認済み。
