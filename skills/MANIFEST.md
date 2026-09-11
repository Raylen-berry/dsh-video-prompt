# Bundle manifest

| Skill | Source | Local role |
| --- | --- | --- |
| `video-prompt-pipeline` | Local composite skill | Orchestrates the complete workflow |
| `watch` | `bradautomates/claude-video` | Video observation, frames, captions, optional Whisper |
| `oneshot-prompt-generator` | `jpcaparas/skills` | Reverse-specification guidance |
| `prompt-videos` | `replicate/skills` | Video prompt optimization guidance |
| `video-generation` | `bytedance/deer-flow` | Structured video generation workflow |
| `viral-media-copywriter` | 本地打包（2026-09-11 随 viral-media-copywriter.zip 进包） | 通用爆款素材模型：素材库清点、四层抽象元素卡、跨样本创意基因与原创文案 |

`watch/scripts/frames.py` 与 `whisper.py` 为本地维护版：在上游基础上加了
`encoding="utf-8", errors="replace"`（中文 Windows 下 ffmpeg 崩溃修复，插件 README 已修坑 3），
**升级上游时必须保住这几处**（2026-09-11 合并 video-prompt-pipeline-*-20260910 两个包时，
其脚本版没有这两处修复，维持了本地版；其 `video-prompt-pipeline/SKILL.md` 的 Phase 3
「两张 ChatGPT 浏览器参考图」流程已并入本地版）。

The upstream skill files are included as installed at packaging time. Review upstream changes before upgrading the bundle.
