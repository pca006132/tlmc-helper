# TLMC 工具使用说明（简体中文）

English: [README_EN.md](README_EN.md)

## 先看这个：目录结构必须符合 TLMC 约定

本工具**不做智能猜目录**，默认你已经按 TLMC 风格整理好目录。

- 在一个根目录下放多个社團文件夹（支持 `[社團名]`、`[社團名] 其他文字`、`社團名`）
  - 若是 `[XXX] YYY` 格式，程序只提取 `XXX` 作为社團名
- 每个社團目录下可以有：
  - 专辑 `.rar`
  - 已解压的专辑文件夹

如果目录结构不符合，分析结果可能不符合预期。

目录结构示例：

```text
音乐库根目录/
├── [RD-Sounds]/
│   ├── 2024.05.03 [RDS-0001] Example Album [Reitaisai].rar
│   └── 2024.05.03 [RDS-0002] Another Album [M3]/
│       ├── disc.flac
│       └── disc.cue
├── [TUMENECO] 冷猫/
│   └── 2025.08.16 [AECD-0001] Sample Album/
│       ├── album.flac
│       └── album.cue
└── 彩音 ～xi-on～/
    └── 2023.12.30 [XIOS-1234] Winter Works/
        ├── CD1.flac
        └── CD1.cue
```

要点：
- 运行目录是“音乐库根目录”。
- 第一层必须是社團目录。
- 第二层是专辑（`.rar` 或已解压目录）。

## 4 个程序分别做什么

- `split-album`：解包、配对 FLAC/CUE、分轨并写初始标签
- `scan-albums`：扫描已有音频标签 -> `metadata.json`
- `analyze-albums`：统一流程生成/更新 `structured.json` 和 `rewriting.json`，并始终生成 `update-metadata.json`
- `apply-tags`：把 `update-metadata.json` 回写到音频文件

## Windows 用户：点击哪个 exe？

在构建输出目录（通常是 `target/release`）里：

1. `split-album.exe`（可选，如果你要从整轨+CUE分轨）
2. `scan-albums.exe`
3. `analyze-albums.exe`（首次会自动生成 `structured.json` / `rewriting.json` / `update-metadata.json`）
4. 编辑 `structured.json` 和/或 `rewriting.json`
5. `analyze-albums.exe`（刷新规则统计并重算 `update-metadata.json`）
6. `apply-tags.exe`

`.exe` 可以直接双击，不需要 `.bat`。  
日志和审计都写文件（`verbose.log` / `audit.json`）。`error.log` 仅在出现错误时才会创建。

## 命令行方式（可选）

```bash
cargo run --bin scan-albums
cargo run --bin analyze-albums
# 编辑 structured.json / rewriting.json
cargo run --bin analyze-albums
cargo run --bin apply-tags
```

## 你会看到的文件

- `metadata.json`：扫描得到的原始标签快照
- `structured.json`：专辑/分盘/曲目结构主文件
- `rewriting.json`：重写规则、默认流派、名字统计（给人和 LLM 看）
- `update-metadata.json`：实际待写回的差异补丁（每次 `analyze-albums` 都会生成）
- `audit.json`：所有需要人工关注的问题
- `verbose.log`：详细过程日志
- `error.log`：硬错误（仅在有错误时存在）

## `structured.json` 与 `rewriting.json` 怎么分工

- `structured.json`：只放结构和曲目编辑内容（专辑/盘/曲目字段）。
- `rewriting.json`：只放重写与聚合信息：
  - `all artists` / `all album artists`（字典：名字 -> 计数）
  - `artists rewriting` / `album artists rewriting` / `genre rewriting`
  - `all genres` / `default genre`

## 重写工作流（非常重要）

1. 先看每个社團下的：
   - `rewriting.json` 里的 `all album artists`
   - `rewriting.json` 里的 `all artists`
2. 找出同一人/同一组合的不同写法、错别字、别名。
3. 在 `rewriting.json` 里写规则统一这些名字。
4. 再跑一次 `analyze-albums`。
5. 再看 `rewriting.json` 的聚合结果，确认不想要的旧写法是否还存在。

如果还在，继续补 rewriting 规则并重复上面步骤。

## rewriting 规则（单轮）

格式：

```json
{ "from": ["旧写法"], "to": ["新写法A", "新写法B"] }
```

规则是**单轮匹配**，不会无限链式继续改。  
同一目标 `to` 的规则会自动合并 `from`（按集合语义），例如 `A -> C` + `B -> C` 会合并为 `["A", "B"] -> ["C"]`。

为什么不做到“重写到收敛（saturation）”：

- 有些名字本身有歧义，自动多轮重写可能会过度合并到错误目标。
- 单轮 + 早匹配优先可以让你精确控制：把“需要保留的写法”放在前面的规则里先匹配到，即可阻止后续规则继续改写。
- 这等价于你可以显式写“提前命中且不再继续”的策略，避免误伤。

复杂示例（与 `task.md` 一致）：

```json
[
  { "from": ["Aky"], "to": ["Aki"] },
  { "from": ["Aki", "AKI"], "to": ["Akiha"] },
  { "from": ["Akiha x S"], "to": ["Akiha", "S"] }
]
```

- `["Aky"]` -> `["Aki"]`（不会继续变成 `Akiha`）
- `["Aki"]` -> `["Akiha"]`
- `["Akiha x S"]` -> `["Akiha", "S"]`

如果规则存在这种“还可以继续改”的链，`audit.json` 里会有 `rewrite_chain_warning` 提示你检查。

### 自动生成规则（analyze-albums）

`analyze-albums` 会在缺少 `rewriting.json` 时自动生成一批初始规则，核心逻辑如下：

1. 先做名字切分（split）：
   - 先按预处理分隔符 `;` 和 `\u0000` 分词；
   - 再按常见连接符切分（如 ` + `、` ＋ `、` x `、` & `、` ＆ `、` / `、` ／ `、` `vs.` / `vs`、`×`、`，`、`、`、`,` 等，括号外生效）。
2. 再做名字归一化（normalization）：
   - 全角 ASCII 折叠、转小写、去空白、引号统一；
   - 同一归一化分组里，优先选择出现次数最多的写法作为目标写法。
3. 低置信度归一化（parenthesis cases）：
   - `NAME (AFFILIATION)` -> `NAME`
   - `ROLE (CV:ARTIST)` -> `ARTIST`
   - 这两类规则按低置信度处理，并在输出里排在更前面，方便人工优先检查。

## 其他关键行为

- `scan-albums` 读取多艺术家时把 `;` 当分隔符。
- `apply-tags` 写回多艺术家时也用 `;` 拼接。
- 盘号由 `structured.json` 的 `discs` 顺序自动推断（第 1 组是 Disc 1，以此类推）。
- `analyze-albums` 只有一个流程：
  - 若缺少 `structured.json`，先自动构建；
  - 若缺少 `rewriting.json`，先自动生成规则；
  - 若 `rewriting.json` 已存在，则保留其规则和 `default genre`，并刷新 `all artists` / `all album artists` / `all genres`。
- 名字预处理会先按 `;` 和 `\\u0000` 分割；这些分隔符不会保留在规则项或 `all artists` / `all album artists` 名字中。

## 审计建议

每次运行后至少检查：

- `audit.json`
- `error.log`
- `rewriting.json`（在改名规则后）

## `audit.json` 字段说明（逐项）

- `missing_cue`：有 FLAC 但找不到对应 CUE。  
  处理：先检查/修正命名与配对，再重跑 `split-album`。也可能是误报（见下方“常见误报场景”）。
- `missing_flac`：有 CUE 但找不到对应 FLAC。  
  处理：先检查文件是否缺失或命名不一致，再重跑 `split-album`。也可能是误报（见下方“常见误报场景”）。
- `multi_disc`：同一专辑目录里识别出多组 FLAC/CUE。  
  处理：检查是否需要手工确认分盘和专辑名。
- `corrupt_cuesheet`：CUE 解析失败、轨道时长非正、或最后轨道偏移超过 FLAC 时长。  
  处理：修复命名或 CUE 后重跑 `split-album`。也可能是误报（见下方“常见误报场景”）。
- `missing_info`：标签信息缺失（常见是 artists）。  
  处理：在 `structured.json` 或源文件标签中补全。
- `invalid_names`：目录命名不符合预期（社團名/专辑名无法正确解析）。  
  处理：修正目录名后重跑 `split-album`（以及后续流程）。
- `ambiguous_pairing`：FLAC 与 CUE 的关联有歧义，无法自动决定。  
  处理：改文件名让配对关系唯一后，重跑 `split-album`。
- `corrupted_tracks`：扫描时音频文件损坏或不可读。  
  处理：若来源于分轨产物，先修复命名/源文件后重跑 `split-album`；若只是扫描阶段发现，替换/修复后重跑 `scan-albums`。
- `disc_classification`：`analyze-albums` 使用了回退分盘规则（需要人工确认）。  
  处理：检查 `structured.json` 的 `discs` 分组是否正确。
- `different_album_artist`：同专辑内 album artists 不一致，或与社團名关系异常。  
  处理：在 rewriting 规则里统一，或手工调整结构数据。
- `rewrite_chain_warning`：重写规则可能存在链式不完整（单轮重写下可能改不彻底）。  
  处理：把链式规则扁平化，确保一步到目标写法。

  示例（为什么不好）：
  ```json
  [
    { "from": ["Aky"], "to": ["Aki"] },
    { "from": ["Aki"], "to": ["Akiha"] }
  ]
  ```
  在单轮重写里，`Aky` 只会变成 `Aki`，不会继续变成 `Akiha`，所以结果里会残留中间态名字，导致聚合名单不干净。  
  解决：改成一步到位，例如：
  ```json
  [
    { "from": ["Aky", "Aki"], "to": ["Akiha"] }
  ]
  ```

### 常见误报场景（重点）

`missing_cue` / `missing_flac` / `corrupt_cuesheet` 不一定总是实际问题。  
典型场景：专辑里已经有“分好轨的单曲文件”，而某首单曲文件名刚好和专辑名接近；程序可能把专辑级 CUE 错配到单曲上，导致：

- 该单曲被报 `corrupt_cuesheet`（因为 CUE 期望的是整轨长音频）；
- 同专辑其他文件被连带报 `missing_cue` 或 `missing_flac`。

遇到这种情况，如果该目录本来就已经是分轨结果，通常直接移除（或移走）误配对的专辑级 CUE 就够了；因为本来就不需要再分轨。  
处理后再重跑 `split-album`，通常可消除误报。

## 安全建议

1. 先备份再批量处理。
2. 先小范围跑通流程再全量执行。
3. `apply-tags` 前抽样检查补丁内容与目标专辑。
