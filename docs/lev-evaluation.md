# interfaze-ai/lev のコンパクション適性評価（2026-09-26）

## lev とは
- `Qwen/Qwen3.5-4B` 上の LoRA アダプタ（r=32, α=64, q/k/v/o + MLP）。reflex の現行ベースと同一ベースモデル。
- `/v1/systemone` 互換。noul は 0〜8 の rating を読んで p(yes)=Σ(i/8)·p_i に畳み込む（`noul_readout: rating`、chat プロンプト形式、per-type 温度較正付き）。
- 本家実装: `github.com/Abhinavexists/lev`（`packages/lev`）。

## 評価方法
ラベル付き合成トランスクリプト 2 本（計 17 call、stale 11 / needed 6）を `compactMessages()`（`preserveRecentMessages: 1`、`keepThreshold: 0.5`）で投げ、`keepResult` の AUC と drop 数を比較。RTX 3060 12GB、`--max-pack-tokens 640`。

| 構成 | AUC(result) | AUC(call) | stale 平均 | needed 平均 | stale 削除 | needed 削除 | 所要(A/B) |
|---|---|---|---|---|---|---|---|
| reflex 素（ベースモデル） | 0.977 | 1.000 | 0.731 | 0.860 | 0/11 | 0/6 | 1.4s / 0.6s |
| reflex + lev アダプタ（キー変換後、較正なし） | 0.924 | 0.970 | 0.158 | 0.795 | 10/11 | 1/6※ | 2.7s / 1.2s |
| lev 本家サーバ（`prefix_mode=fork`） | 0.939 | 0.848 | 0.262 | 0.877 | 9/11 | 0/6 | 33s / 7〜15s |

※ 削除された needed は `Edit` の結果（"The file ... has been updated."）で `drop_result`（call は保持）。実害なし。

## 結論
- **ベースモデルは順位付けは既にできているが、確率が 0.5 より上に偏り一切削れない**（既知のキャリブレーション問題の再確認）。離散値使い回しも lev では解消（distinct 15〜17/17）。
- **lev アダプタを載せると p(keep) が 0.5 を境に正しく分離し、実際に削れるようになる**。コンパクション用途には明確に向いている。
- **運用するなら「reflex-serve + lev アダプタ」**。lev 本家サーバは 12GB GPU では遅すぎ（1 リクエスト 33 秒 → hook の `$.http.fetch` 30 秒制限を超過、VRAM 12GB 張り付き）で不適。
- 注意: サンプル 17 件の合成データのみ。実セッションでの検証は未実施（下記の既存ダンプ再生はサービング側のハングで中断）。

## reflex で lev を使う手順
`reflex-serve --adapter interfaze-ai/lev` をそのまま使うと **アダプタが一切適用されない**（`CLAUDE.md` ハマりポイント参照）。キーを変換したローカルコピーを作って渡す:

```python
from huggingface_hub import hf_hub_download
from safetensors.torch import load_file, save_file
import shutil, os
out = "runs/lev-mm"; os.makedirs(out, exist_ok=True)
sd = load_file(hf_hub_download("interfaze-ai/lev", "adapter_model.safetensors"))
sd = {k.replace("base_model.model.model.layers.", "base_model.model.model.language_model.layers."): v for k, v in sd.items()}
save_file(sd, f"{out}/adapter_model.safetensors", metadata={"format": "pt"})
shutil.copy(hf_hub_download("interfaze-ai/lev", "adapter_config.json"), f"{out}/adapter_config.json")
```

```bash
uv run reflex-serve --max-pack-tokens 640 --adapter runs/lev-mm
```

- lev の `calibration.json` は形式（`temperatures` キー、`noul:A` 等）が reflex の `Calibration`（`temperature` キー）と非互換。そのまま隣に置くと `KeyError` になるので置かない（上記では温度 1.0 で評価）。
- reflex のプロンプトは lev の学習形式（chat + 0〜8 rating）と異なる yes/no readout だが、それでも上表の通り分離できた。

## lev 本家サーバを動かす場合のメモ
- デフォルト `prefix_mode="single"` は state 全文 ×（質問数×2 順序）行を一括バッチし全語彙 logits を持つため、12GB では VRAM 溢れ → WDDM の sysmem fallback で 5 分超ハング。`DecisionEngine` の config を `prefix_mode="fork"` に差し替える必要がある（CLI フラグ無し）。
- reflex の `.venv`（transformers 5.17 / peft 0.21）で `PYTHONPATH=packages/lev/src` を通せば追加インストール不要で起動できる。
- 初回リクエストは fla の Triton JIT コンパイルで数分かかる。
