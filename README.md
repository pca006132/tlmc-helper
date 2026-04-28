# TLMC 一键分轨工具（简体中文）

English version: [README_EN.md](README_EN.md)

> 说明：本 README 内容主要是根据 `task.md` vibed 出来的用户文档，目标是给普通用户快速上手。

## 这是什么

这是一个给东方同人专辑用的“一键分轨”工具。  
它会在当前目录下扫描社团文件夹，解压 `.rar` 专辑包，读取 `.cue`，把整轨 `.flac` 切成单曲，并写入常见标签。

## 使用前准备

1. 把可执行文件放在一个“总目录”中。
2. 总目录下每个子目录代表一个社团（可以是 `[CIRCLE_NAME]`，也可以是不带 `[]` 的普通名称）。
3. 每个社团目录里可以放 `.rar` 专辑文件，也可以直接放已解压的专辑目录（两者都支持）。
4. 建议先备份一份原始资源（尤其是首次使用时）。

目录示意：

```text
总目录/
  社团A/
    2026.04.28 [ABCD-0123] foo bar [c123].rar
  社团B/
    2025.10.01 [WXYZ-0001] album name.rar
  tlmc.exe
```

## 如何使用

### 传统一键分轨（split-album）

1. 运行 `split-album`（Windows 可双击 exe）。
2. 等待处理完成。
3. 打开 `verbose.log`、`error.log` 和 `audit.json`，确认是否有需要人工处理的专辑。

### 元数据工作流（新二进制）

1. 扫描现有音频元数据：
   - `scan-albums`
   - 输出：`metadata.json`
2. 分析并生成可编辑结构：
   - `analyze-albums`
   - 当 `structured.json` 不存在时，生成 `structured.json`
3. 编辑 `structured.json`（人工调整重写规则、默认流派等）。
4. 生成待更新清单：
   - 再次运行 `analyze-albums`
   - 当 `structured.json` 已存在时，生成 `update-metadata.json`
5. 应用标签：
   - `apply-tags`
   - 按 `update-metadata.json` 并行回写标签

命令示例（在项目根目录）：
```bash
cargo run --bin scan-albums
cargo run --bin analyze-albums
# 编辑 structured.json
cargo run --bin analyze-albums
cargo run --bin apply-tags
```

## `structured.json` 说明（需要人工编辑）

`structured.json` 是“分析结果 + 重写规则配置”的中间文件。  
第一次运行 `analyze-albums` 会生成它；你修改后再次运行 `analyze-albums` 才会生成 `update-metadata.json`。

核心结构（按圈组织）：

- `all album artists` / `all artists` / `all genres`
  - 当前圈聚合出来的候选值（已去重、排序）
- `album artists rewriting` / `artists rewriting` / `genre rewriting`
  - 重写规则列表，格式为：
  - `{ "from": ["A", "B"], "to": ["C"] }`
- `default genre`
  - 可选。用于补全没有 genre 的曲目
- `albums`
  - 每张专辑的信息
  - `album artists`: 专辑级艺术家列表
  - `discs`: 分盘后的曲目映射（`TRACK_PATH` -> 曲目信息）

最小示例：

```json
{
  "CircleName": {
    "all album artists": ["AAA", "Aaa"],
    "album artists rewriting": [
      { "from": ["AAA", "Aaa"], "to": ["AAA"] }
    ],
    "all artists": ["X", "Y"],
    "artists rewriting": [],
    "all genres": ["Trance", "Electronic"],
    "genre rewriting": [],
    "default genre": "Electronic",
    "albums": {}
  }
}
```

编辑建议：

1. 先检查并修正 `* rewriting` 规则（这是最关键的）。
2. 需要补流派时填写 `default genre`。
3. 如分盘结果可疑，检查 `albums -> ... -> discs` 的分组。
4. 改完后再运行一次 `analyze-albums` 生成 `update-metadata.json`。

程序特性：

- 不需要命令行参数
- 处理信息同时输出到屏幕和 `verbose.log`
- 出错会记到 `error.log`，尽量不中断整体流程

## 转换后会发生什么

- 只有在“同名目录不存在”时，`.rar` 才会被解压到同名目录（去掉 `.rar` 后缀）。
- 即使没有对应 `.rar`，已有专辑目录也会被直接处理。
- 会查找并配对 `.flac` 与 `.cue`。
- 成功分轨后生成：`TRACK_ID - TRACK_NAME.flac`
- 处理过的原始 `.flac` 和 `.cue` 会改名为 `*.old`
- 如果目录中已存在 `.flac.old` 或 `.cue.old`，会判定为已处理并跳过该目录。
- 多盘（多组 flac-cue）时会放入子目录（按原 flac 文件名分开）

## 审计输出说明（重点）

程序会在执行目录生成以下内容，且审计路径均为相对路径，便于人工排查：

- `verbose.log`
  - 详细处理日志（也会输出到控制台）
  - 包含专辑处理过程、配对结果、审计记录等
- `error.log`
  - 错误日志（例如某个专辑/某个配对失败）
  - 先看这个文件定位硬错误
- `audit.json`
  - 统一审计文件（美化格式 JSON）
  - 结构示例：
```json
{
  "missing_cue": ["circle/album/foo.flac"],
  "missing_flac": ["circle/album/foo.cue"],
  "multi_disc": ["circle/album"],
  "corrupt_cuesheet": ["circle/album/foo.cue"],
  "missing_info": ["circle/album/foo.flac track 01"],
  "invalid_names": ["circle_or_album_path"],
  "ambiguous_pairing": ["circle/album | flac=... | cues=..."],
  "corrupted_tracks": ["circle/album/foo.mp3"],
  "disc_classification": ["circle/album"],
  "different_album_artist": ["circle/album"]
}
```
  - 不同字段含义：
    - `missing_cue`: flac 缺 cue
    - `missing_flac`: cue 缺 flac
    - `multi_disc`: 多盘专辑（多组配对）
    - `corrupt_cuesheet`: cue 内容或时间无效（含 0/负时长）
    - `missing_info`: 缺少关键标签信息
    - `invalid_names`: 圈名/专辑目录名不符合预期
    - `ambiguous_pairing`: 配对存在多候选
    - `corrupted_tracks`: 扫描阶段无法读取的音频文件
    - `disc_classification`: 分盘规则触发人工确认
    - `different_album_artist`: 专辑艺术家不一致或与圈名不匹配

## 全部跑完后你该做什么

建议按这个顺序检查：

1. 先看 `error.log`，确认是否有失败项目。
2. 看 `audit.json` 的 `corrupt_cuesheet`，修复或替换损坏 cue 后可重跑。
3. 看 `audit.json` 的 `missing_cue` / `missing_flac`，补齐缺失文件。
4. 看 `audit.json` 的 `multi_disc` / `ambiguous_pairing`，确认配对与多盘结构。
5. 看 `audit.json` 的 `missing_info`，补全曲目标签（标题、表演者等）。
6. 抽查若干专辑试听，确认切点与曲目顺序正确。
7. 确认没问题后，再决定是否删除 `*.old` 原始文件。

## 注意事项

- 程序会重命名原始 `flac/cue` 为 `*.old`，请先确认你有备份策略。
- 建议在整理副本上运行，避免直接对唯一原始库操作。
- 如果想“修完问题再跑一遍”，可以保留日志文件作为待办清单。
- **修 cue 后重跑建议**：如果该目录已经生成过 `.flac.old/.cue.old`，程序会跳过该目录。你可以先把这些 `.old` 文件移走（或恢复文件名），再重跑。
- 如果 cue 缺少 `DATE` 或顶层 `PERFORMER`，程序会尝试从目录名补信息；当目录名无效且无法补信息时，会记 `error.log` 并跳过该专辑。
- 如果 cue 的轨道时间计算出 0 或负时长，会视为损坏 cue，记录到 `audit.json` 的 `corrupt_cuesheet` 并跳过该配对。
- `metadata.json`、`structured.json`、`update-metadata.json`、`audit.json` 都是美化（pretty）JSON，方便人工编辑和审查。
