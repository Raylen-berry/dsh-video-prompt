# Bundle manifest

| Skill | Upstream source（仓库 → 真实路径） | 上游许可证 | Local role |
| --- | --- | --- | --- |
| `video-prompt-pipeline` | 本地合成技能（见下方「`watch/scripts/frames.py` 与 `whisper.py` 为本地维护版」那段） | — | Orchestrates the complete workflow |
| `watch` | [`bradautomates/claude-video`](https://github.com/bradautomates/claude-video) → `skills/watch/` | MIT | Video observation, frames, captions, optional Whisper |
| `oneshot-prompt-generator` | [`jpcaparas/skills`](https://github.com/jpcaparas/skills) → `skills/creative/oneshot-prompt-generator/` | **未声明**（仓库根目录无 LICENSE 文件） | Reverse-specification guidance |
| `prompt-videos` | [`replicate/skills`](https://github.com/replicate/skills) → `skills/prompt-videos/` | **Apache-2.0**（不是 MIT） | Video prompt optimization guidance |
| `video-generation` | [`bytedance/deer-flow`](https://github.com/bytedance/deer-flow) → `skills/public/video-generation/` | MIT | Structured video generation workflow |
| `viral-media-copywriter` | 本地打包（2026-09-11 随 viral-media-copywriter.zip 进包）；**上游未确认**：包内无作者无仓库，GitHub 按名搜索 `total_count=0` | 来源未确认 | 通用爆款素材模型：素材库清点、四层抽象元素卡、跨样本创意基因与原创文案 |

**许可证那一列是 2026-09-14 用 GitHub API 逐个回读核实的**（`/repos/{o}/{r}/license`），不是照抄"应该都是 MIT"。
两处需要当回事：

- `replicate/skills` 是 **Apache-2.0**：随分发要保留其 LICENSE/NOTICE 并在修改处声明变更，义务比 MIT 重。
- `jpcaparas/skills` **根目录没有 LICENSE 文件** ⇒ 默认保留所有权利，不能假定可自由再分发。要继续用就得
  先向作者取得许可或在包里注明"应作者许可/仅本地参考"，别把"它挂在 GitHub 上"当成"它允许我分发"。

`oneshot-prompt-generator` 的旧记录少写了一层 `skills/creative/`（按旧记录去上游找会找不到），路径已核实为
`raw.githubusercontent.com/jpcaparas/skills/main/skills/creative/oneshot-prompt-generator/SKILL.md` → HTTP 200。

`watch/scripts/frames.py` 与 `whisper.py` 为本地维护版：在上游基础上加了
`encoding="utf-8", errors="replace"`（中文 Windows 下 ffmpeg 崩溃修复，插件 README 已修坑 3），
**升级上游时必须保住这几处**（2026-09-11 合并 video-prompt-pipeline-*-20260910 两个包时，
其脚本版没有这两处修复，维持了本地版；其 `video-prompt-pipeline/SKILL.md` 的 Phase 3
「两张 ChatGPT 浏览器参考图」流程已并入本地版）。

The upstream skill files are included as installed at packaging time. Review upstream changes before upgrading the bundle.
