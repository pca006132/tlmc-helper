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
- 第二层“专辑目录名”现在支持宽松格式（`analyze-albums`）：
  - 可选日期前缀：`YYYY` / `YYYY.MM` / `YYYY.MM.DD`（也接受 `-` 分隔）
  - 可选首个记录号方括号：如 `[ABCD-1234]`
  - 日期和方括号都可省略；但目录名必须包含专辑名部分

## 3 个 Rust 程序 + Web App 分别做什么

- `split-album`：解包、配对 FLAC/CUE、分轨并写初始标签
- `scan-albums`：扫描已有音频标签 -> `metadata.json`
- Web App：统一流程生成/更新 `structured.json`、`rewriting.json`，并生成 `update-metadata.json`
- `apply-tags`：把 `update-metadata.json` 回写到音频文件

## Windows 用户：点击哪个 exe？

在构建输出目录（通常是 `target/release`）里：

1. `split-album.exe`（可选，如果你要从整轨+CUE分轨）
2. `scan-albums.exe`
3. 打开 Web App（优先使用 GitHub Pages 部署版）
4. 导入 `metadata.json`（可选再导入 `structured.json` / `rewriting.json`）
5. 在界面中编辑并点击 `Sync now`，下载新的 `structured.json` / `rewriting.json` / `update-metadata.json`
6. `apply-tags.exe`

`.exe` 可以直接双击，不需要 `.bat`。  
日志和审计都写文件（`verbose.log` / `audit.json`）。`error.log` 仅在出现错误时才会创建。

GitHub Pages 地址：`https://pca006132.github.io/tlmc-helper/`（启用仓库 Pages 后可访问）

## 命令行方式（可选）

```bash
cargo run --bin scan-albums
cargo run --bin apply-tags
```

## 你会看到的文件

- `metadata.json`：扫描得到的原始标签快照
- `structured.json`：专辑/分盘/曲目结构主文件
- `rewriting.json`：重写规则、默认流派、名字统计（给人和 LLM 看）
- `update-metadata.json`：实际待写回的差异补丁（每次 Web App `Sync now` 后生成）
- `audit.json`：所有需要人工关注的问题
- `verbose.log`：详细过程日志
- `error.log`：硬错误（仅在有错误时存在）

## 推荐流程（Web App 优先）

1. `split-album`（需要分轨时）
2. `scan-albums`
3. 打开 Web App，导入并编辑，点击 `Sync now`
4. 下载新的 `update-metadata.json`
5. `apply-tags`

## `structured.json` 与 `rewriting.json` 怎么分工（手动编辑时）

- `structured.json`：只放结构和曲目编辑内容（专辑/盘/曲目字段）。
- `rewriting.json`：只放重写与聚合信息：
  - `all artists` / `all album artists`（字典：名字 -> 计数）
  - `artists rewriting` / `album artists rewriting` / `genre rewriting`
  - `all genres` / `default genre`
  - 特殊顶层 `$all`（同结构）：跨全部社團聚合计数；规则不会自动生成，只保留人工维护内容

### `structured.json` 结构速览

建议把 `structured.json` 和 `rewriting.json` 配合编辑：前者改结构/曲目字段，后者做名字与流派归一化。

`structured.json` 的层级是：

- 顶层：`社團 -> albums`
- `albums`：`专辑名 -> { "album artists", "discs" }`
- `discs`：数组，每个元素是一个字典：
  - 可选 `"$subtitle"`：该盘副标题
  - 其余键是 `track_path`，值为曲目对象
- 曲目对象字段：
  - 必填：`title`、`track number`、`artists`
  - 可选：`date`、`genre`

- 曲目标题归一化：轨道号为 `1` 时，`1 Name` / `01. Name` / `(01) Name` / `[01]-Name` 会归一化为 `Name`，并记录到 `audit.track_title_rewrite`。


## 重写工作流（非常重要）

1. 先看每个社團下的：
   - `rewriting.json` 里的 `all album artists`
   - `rewriting.json` 里的 `all artists`
2. 找出同一人/同一组合的不同写法、错别字、别名。
3. 在 `rewriting.json` 里写规则统一这些名字。
4. 在 Web App 里点一次 `Sync now`。
5. 再看 `rewriting.json` 的聚合结果，确认不想要的旧写法是否还存在。

如果还在，继续补 rewriting 规则并重复上面步骤。

## rewriting 规则（单轮）

格式：

```json
{ "from": ["旧写法"], "to": ["新写法A", "新写法B"] }
```

规则在**运行时**是单轮匹配（first-match、top-to-bottom），不会无限链式继续改。  
同一目标 `to` 的规则会自动合并 `from`（按集合语义），例如 `A -> C` + `B -> C` 会合并为 `["A", "B"] -> ["C"]`。

补充：自动生成规则时会做“收敛编译”（saturate）和不可达规则剔除，尽量把链式关系提前折叠；  
但**实际应用到名字**时仍然是单轮匹配，这样可以保留人工规则的可控性。

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

### 自动生成规则（Web App Sync）

Web App 在缺少 `rewriting.json` 时会自动生成一批初始规则，核心逻辑如下：

1. 先做名字切分（split）：
   - Web App 不做 `;` / `\u0000` 这种二次分词；它直接使用 `metadata.json` 里的 artists / album artists 数组。
   - 再按常见连接符切分（如 `ft.`、`feat.`、` + `、` ＋ `、` x `、` & `、` ＆ `、` / `、` ／ `、` `vs.` / `vs`、`×`、`，`、`、`、`；`、`,` 等，括号外生效）。
2. 再做名字归一化（normalization）：
   - 分三类规则，按顺序执行：
     1) 低置信度 regex（如 parenthetical / CV）
     2) 高置信度 regex（如前缀 `vo.`）
     3) simple normalize（全角 ASCII 折叠、转小写、去空白、引号统一；同一归一化分组优先出现次数最多写法）
3. 低置信度 regex 归一化（parenthesis cases）：
   - `NAME (AFFILIATION)` -> `NAME`
   - `ROLE (CV:ARTIST)` -> `ARTIST`
   - 这两类规则按低置信度处理，并在输出里排在更前面，方便人工优先检查。
4. aggressive split（激进切分）：
   - 使用贪心 + offset 扫描，只尝试 aggressive 分隔符（如 `&`、`/`、`+`）；
   - 每次候选切分只有在至少一侧命中已知名字（归一化后）时才接受；
   - 未命中的另一侧若仍包含 aggressive 分隔符，会进入 worklist 继续尝试拆分。


## Web

- 新社團规则自动生成：已有 `rewriting.json` 时，出现新社團会自动生成该社團规则。

## 其他关键行为

- `scan-albums` 读取多艺术家时把 `;` 当分隔符。
- `scan-albums` / `apply-tags` 支持 artists / album artists 的多值标签：
  - 扫描时会把多值解析为数组；
  - 写回时会以多值标签形式写入（不是单字符串拼接）。
- 盘号由 `structured.json` 的 `discs` 顺序自动推断（第 1 组是 Disc 1，以此类推）。
- Web App 的路径解析按固定层级处理：`circle/album/...`，第二层目录始终视为专辑目录。
- 专辑目录名解析（regex）支持：
  - 可选日期前缀：`YYYY` / `YYYY.MM` / `YYYY.MM.DD`
  - 日期分隔符兼容 `.` 与 `-`（内部统一按 timestamp 语义处理）
  - 可选首个方括号记录号（如 `[ABC-1234]`）
  - 从目录名中提取“专辑名”部分作为结构化专辑名
- 日期处理：
  - 若 metadata 缺失日期，且专辑目录可提取日期，则使用目录日期（保留原有精度，不补月/日）
  - 若 metadata 日期与目录日期一致但 metadata 精度更低，优先目录日期
  - 若不一致，保留 metadata，并写入 `audit.json.inconsistent_date`
- Web App `Sync now` 只有一个流程：
  - 若缺少 `structured.json`，先自动构建；
  - 若缺少 `rewriting.json`，先自动生成规则；
  - 若 `rewriting.json` 已存在，则保留其规则和 `default genre`，并刷新 `all artists` / `all album artists` / `all genres`。
- 重写优先级：先执行社團内规则，再执行 `$all` 规则（`$all` 优先级最低）。

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
- `inconsistent_date`：metadata 日期与专辑目录推断日期不一致。  
  处理：人工确认真实日期来源；若目录日期更可靠，修正 metadata 或结构化结果后在 Web App 再次 `Sync now`。

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
