---
name: video-prompt-pipeline
description: 视频复刻：将源视频分析、逆向还原为可复用的生成提示词，并在明确请求时生成两张浏览器 ChatGPT 参考图和新视频。适用于“用视频复刻帮我……”的视频复刻、逐镜头重建、参考图驱动视频生成或完整的 watch → reverse prompt → optimize → generate 工作流。
---

# Video Prompt Pipeline

Use this skill when the user asks for “视频复刻” or wants to recreate the visual language or motion of a supplied video, not merely summarize it. Optimize in this order: lowest cost, easiest setup, then highest fidelity. The default deliverable is a preserved analysis bundle plus two prompts; actually generating a new video is an explicit final action.

## Cost-first policy

- Prefer local files and local processing. Let `watch` try native platform captions first. Do not pass `--no-whisper` in the normal caption-first mode: if native captions are absent and a Whisper key is configured, `watch` may fall back to Whisper; use `--no-whisper` only for an explicit zero-cost run.
- For short clips, use `efficient` or a capped `balanced` pass. Do not use `token-burner` unless the user explicitly chooses maximum fidelity.
- Keep `oneshot-prompt-generator` and `prompt-videos` as guidance sources, but perform their handoff in one Agent context by default. Do not create a separate external service, plugin, or model call for the middle conversion.
- When the user requests a generated first frame or reference image, use their already signed-in ChatGPT web session through the browser-control skill. Generate two purposeful still images by default: one opening first frame and one visually decisive keyframe. Do not create further variations or use an API key as a substitute.
- Treat `video-generation` as an opt-in cost boundary. Before calling it, check the configured provider and required key; if cost or model pricing cannot be verified, produce the JSON and ask the user to choose a provider/model.
- Do not install additional skills merely to make this pipeline look more integrated. Search for a single integrated replacement only when this workflow fails or the user explicitly requests a comparison.

## Caption and Whisper cost policy

`watch` must follow this order:

| Source condition | Whisper call | Transcription cost |
| --- | --- | --- |
| The source provides native captions, such as YouTube or Bilibili subtitles | No. Use the captions returned by `watch`. | Free from the Whisper provider; no audio is sent to Whisper. |
| Native captions are unavailable and a Whisper key is configured | Yes. Use the configured Groq or OpenAI Whisper fallback. | Potentially billable according to the provider and audio duration. |
| Native captions are unavailable and no Whisper key is configured | No. Continue with frames only and mark the transcript unavailable. | Free, but spoken content remains unknown. |
| The user explicitly requests zero-cost processing | No. Pass `--no-whisper`, even if native captions are unavailable. | Free, with the same frames-only limitation when no captions exist. |

Never infer that a Whisper call occurred merely because a transcript is present: native captions are the preferred free path. In the run report, record the transcript source as `native captions`, `whisper (groq)`, `whisper (openai)`, or `none` when the component exposes it. Do not expose API keys in logs or artifacts.

## Components

Use the installed component skills as the source of truth for their detailed behavior:

1. `watch` — download or inspect the source, extract scene-aware frames, and obtain captions or a timestamped transcript.
2. `oneshot-prompt-generator` — provides the evidence-ledger and time-based reverse-specification guidance. For this pipeline, the target is a video, not a website.
3. `prompt-videos` — provides the model-ready video prompt guidance. By default, combine steps 2 and 3 in one Agent pass rather than handing text between separate invocations.
4. ChatGPT web image generation — optionally create two local reference images (opening first frame and decisive keyframe) from the optimized prompt through the user's signed-in browser session.
5. `video-generation` — convert the optimized prompt into structured JSON and run the configured generator only after the user explicitly asks for generation.

If any component is unavailable, report the missing component and stop before pretending the pipeline completed. Do not silently replace video evidence with a transcript-only summary unless the user accepts that limitation.

## Input contract

Accept a local video path or a public video URL. Ask for the source only when it is missing. If the video is longer than about 10 minutes and the user has not requested full-video analysis, ask which time range or scene to focus on before downloading the whole source.

Collect optional constraints when present: target model/provider, output duration, aspect ratio, resolution, style changes, whether to preserve dialogue or sound, reference images, first/last frames, and whether the goal is faithful recreation or an inspired adaptation. User requirements outrank observations from the source. If the user does not specify a provider, do not guess a paid model during the analysis phase.

## Run layout

Create a durable run directory under the workspace, unless the user specifies another writable directory. When the request comes from the 生图 panel (dsh-video-prompt), the request itself carries both directories: the 产物目录 for the run and a per-dispatch 过程目录 named `<runsRoot>\process\<年-月-日>_<时分>-<素材名>\` — keep every intermediate artifact in the process directory and only the final prompts in the run output; never scatter frames or evidence back into the media folders. For standalone use, `video-prompt-runs\<slug>\` under the workspace is fine. Keep the source-analysis artifacts together:

```text
<run>/
  watch/                       # downloaded media, frames, transcript, report（面板派发时归位到过程目录 frames\）
  inverse-prompt.md            # raw self-contained prompt from reverse specification
  optimized-video-prompt.md    # model-ready natural-language prompt
  chatgpt-reference-prompt.md  # only when a ChatGPT reference image is requested
  references/                  # chatgpt-reference-01 and -02 when image generation is requested
  video-generation.json        # structured prompt for the generation skill
  generated-video.mp4          # only when generation was explicitly requested
```

Do not put API keys in these files. Do not upload the source video to a third-party vision service. The `watch` component may send extracted audio to the configured Whisper provider only as described by its own instructions.

## Phase 1 — Observe the source

Read the `watch` skill before running it and follow its setup preflight. Use its Windows interpreter guidance. In normal caption-first mode, do not pass `--no-whisper`: `watch` first checks native captions and only then falls back to Whisper when captions are missing and a key is available. If the user requests absolute zero cost, pass `--no-whisper`. Prefer `efficient` for clips under 30 seconds, capped `balanced` for clips up to 10 minutes, and a focused `--start`/`--end` range for a specific moment. Use `--out-dir <run>\watch` so the evidence survives the rest of the pipeline (when the dispatch request names a 过程目录, point `--out-dir` at its `frames\` instead).

The observation pass must cover the whole requested range. Align frames with the transcript and record, at minimum:

- shot boundaries and approximate timecodes;
- subject identity, appearance, position, and continuity;
- action, state changes, and the cause/effect between beats;
- camera type, angle, lens impression, framing, focus, and camera motion;
- setting, lighting, color, texture, transitions, and visual style;
- dialogue, ambience, music, sound effects, silence, and synchronization;
- exact on-screen text when legible, and unknowns when it is not.

Read every frame listed by `watch`. If the transcript points to an important visual moment that was not selected, rerun `watch` with `--timestamps` for that moment before moving on.

## Phase 2 — Reverse-specify and optimize in one pass

Read `oneshot-prompt-generator` and its `references/time-based-media.md`, then read `prompt-videos`. Use the observed frames, transcript, and metadata as evidence. Maintain the distinction between observed, inferred, unknown, and user-required details internally.

In the same Agent context, first draft the self-contained reconstruction prompt and save it to `inverse-prompt.md`, then immediately transform that evidence into the model-ready prompt and save it to `optimized-video-prompt.md`. This is one local reasoning handoff, not two separate service calls. Keep the inverse prompt unchanged for comparison.

The inverse prompt must describe the complete temporal arc rather than a representative frame: opening state, meaningful beats, transitions, ending state, motion, sound, and timing. The optimized prompt must preserve those beats while adding concrete camera, motion, audio, and model-facing constraints. Do not implement, render, or generate during this phase.

For a source that is a copyrighted film, ad, or other identifiable work, describe the observable visual and temporal properties without claiming access to hidden production details. Preserve user-requested transformations and avoid adding unsupported specifics.

The optimized prompt should:

- name subjects directly and keep recurring character descriptions verbatim;
- specify scene, subject, action, style, composition, camera position, lens/focus, and camera movement;
- use time-coded shots and explicit transitions when the source has multiple shots;
- describe dialogue, ambience, sound effects, music, and silence; keep dialogue short enough for the duration;
- state `(no subtitles)` when subtitles are not wanted;
- identify what reference images, audio, first frames, or last frames control, and what must remain unchanged;
- include aspect ratio, duration, and resolution only when known or required by the chosen model;
- separate faithful reconstruction from intentional creative changes.

Do not choose a current model from memory. If the user asks to generate through Replicate, use an available model-search/schema capability when present; otherwise preserve the user-selected provider and mark model-specific fields as pending rather than inventing them. If no provider is selected, stop after producing the JSON and ask the user to choose one before incurring generation cost.

## Phase 3 — Optional ChatGPT web reference image

Use this phase only when the user explicitly requests a generated reference image, first frame, keyframe, or a full generation run that expressly includes this image-generation step. It is an external, quota-consuming action: do not run it merely because an optimized prompt exists. Skip it when the user supplies their own reference image or asks not to generate one.

Before browser interaction, read and follow the available browser-control skill. The user chose their already signed-in ChatGPT web session, so use that exact external browser surface; do not replace it with an API, a different image service, or an unsigned-in browser. Do not inspect cookies, passwords, account settings, unrelated chats, or private account data.

Derive two concise still-image prompts from `optimized-video-prompt.md`, rather than pasting the entire video prompt: image 01 recreates the opening/first-frame composition, and image 02 recreates the most visually decisive later keyframe. Save both exact prompts in `chatgpt-reference-prompt.md`. Each should name the subject, action or pose, setting, composition, camera, lighting, palette, aspect ratio, and constraints such as no visible text or watermark. Include `$imagegen` so each request is unambiguous. Generate exactly two images at the target aspect ratio. Ask before requesting a third image, an edit, or another variation.

After ChatGPT finishes, save the generated images under `<run>\references\chatgpt-reference-01.<ext>` and `<run>\references\chatgpt-reference-02.<ext>`. Verify both files are non-empty and keep their local paths. If browser control, sign-in, a plan limit, a download, or the ChatGPT page prevents completion, report the precise blocker and preserve the prompt file; do not silently switch to another provider. In Phase 4, map both paths to the selected video generator's documented reference-image fields after reading `video-generation`. If that generator accepts only one reference image, ask the user which of the two should control the render.

## Phase 4 — Structure and optionally generate

Read `video-generation`. Convert the optimized prompt into `video-generation.json` with explicit fields for title, duration, aspect ratio, background/scene, characters or subjects, camera, shot timing, actions, dialogue, and audio. Keep the JSON semantically faithful to the optimized prompt; do not introduce new story beats. When Phase 3 created a reference image, place its verified local path in the provider's documented reference-image or first-frame field; otherwise omit that field.

Generation is a side-effecting external action and must not happen merely because analysis completed. Generate only when the user explicitly asks to create/render/generate the new video in the current request or a follow-up. Before generation, verify the configured provider/API key, model, duration, resolution, and any model-specific requirements. Prefer the least expensive configured option that meets the user's constraints, but do not claim a provider is cheapest without current pricing evidence. If a required key, model, or reference asset is missing, stop with the exact missing item and preserve the prompt artifacts.

When generation is authorized, call the installed `video-generation` script using the paths in the installed skill and write the result to `<run>\generated-video.mp4`. Follow that skill's instruction not to inspect the generator implementation; invoke it with the structured prompt, reference images if supplied, output path, and aspect ratio. If the provider returns an asynchronous job, poll until completion and preserve any provider error in a small text note beside the output.

## Completion checklist

Before reporting success, verify:

- the requested source range has frames and transcript evidence, or the limitation is explicit; a missing transcript must not block a visual-only run;
- the transcript source is recorded when available, distinguishing native captions from Whisper fallback and from no transcript;
- `inverse-prompt.md` is self-contained and time-aware;
- `optimized-video-prompt.md` contains concrete camera, motion, audio, and transition directions;
- both ChatGPT-generated reference images were explicitly authorized, saved locally, and linked through the correct generation fields (or the user chose one when the provider accepts only one);
- `video-generation.json` parses and does not contradict the optimized prompt;
- generation was performed only with explicit authorization;
- all produced artifacts are in the run directory (and the 过程目录 when the panel dispatched this run) and can be opened by the user.

Report the run directory and the available artifacts. If generation was not requested, say that the pipeline is prepared through the optimized prompt and structured JSON, and leave the final generation step for the user's confirmation.
