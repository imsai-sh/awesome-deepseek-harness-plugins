# Awesome DeepSeek Harness Plugins

> **中文导读**：这是 DeepSeek Harness（DSH）生态的插件精选列表，英文为主维护，中文说明见各章节标题下方。想直接上手的高星插件评测请看 [Hands-on Notes](#hands-on-notes)。

A curated list of plugins, tools, skins, bridges, and extensions for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) — the
open-source agent framework from DeepSeek, built on the motto
**"Everything is a Plugin."**

DSH launched its developer preview on **2026-08-13** (MIT license, Cordis-based).
Within a day the community shipped a wave of plugins; this list tracks the
notable ones and points to the rest.

> Star counts are a launch-day snapshot (2026-08-13) and drift fast. For the
> unmoderated, auto-refreshed index of every repo tagged `dsh-plugin`, see
> [PLUGINS.md](PLUGINS.md) (regenerated daily by
> [update.yml](.github/workflows/update.yml)).

> **生态入口 / Ecosystem**：想找插件不想翻列表？去 **[WhaleHub](https://whalehub-dsh.vercel.app)** —— 基于本列表每日同步的可视化插件市场（搜索 / 分类 / 一键复制安装命令，还能装进 DSH Web 里点一下直装）。想零配置上手 DSH？试 **[DeepSeek Harness Desktop](https://dsh-desktop.vercel.app)** —— 自包含 macOS APP（内置 Node + dsh + Paseo），拖进「应用程序」即用。

## Contents

- [How to install a plugin](#how-to-install-a-plugin)
- [Official built-in plugins](#official-built-in-plugins)
- [Community plugins](#community-plugins)
  - [Web UI & Skins](#web-ui--skins)
  - [Terminal & Desktop](#terminal--desktop)
  - [Vision & Multimodal](#vision--multimodal)
  - [Tools & Editor UX](#tools--editor-ux)
  - [Agent orchestration & Workflow](#agent-orchestration--workflow)
  - [Integrations & Bridges](#integrations--bridges)
  - [Sidebar, Workspace & Ecosystem](#sidebar-workspace--ecosystem)
  - [Fun & Misc](#fun--misc)
- [Hands-on Notes](#hands-on-notes)
- [Other awesome lists (meta)](#other-awesome-lists-meta)
- [Contributing](#contributing)
- [License](#license)

## How to install a plugin

**中文**：DSH 把插件当作 [Cordis](https://github.com/cordiverse/cordis) bundle 加载，最常用的两条路：npm 包用 `dsh plugin add <npm-package>`，仓库托管（`.dsh-plugin` 形态）用 `github:<owner>/<repo>` 形式。

DSH loads plugins as [Cordis](https://github.com/cordiverse/cordis) bundles.
Two common paths:

```sh
# npm-scoped plugin (recommended)
dsh plugin add <npm-package>

# repo-hosted plugin (the .dsh-plugin format)
# add to your profile's cordis.yml, or via the CLI patch layer:
# github:<owner>/<repo>#<ref>&path:/.dsh-plugin
```

Start the Web UI and manage models/workspaces there:

```sh
dsh web            # http://127.0.0.1:3080
```

## Official built-in plugins

**中文**：框架本体在 `@deepseek-ai/dsh-*` 这个 npm scope 下自带约 50 个内部插件包，是所有社区插件的参考实现与"接缝"底座（llm / shell / fs / web / subagent / plan / sandbox / hooks / skill …）。

The framework itself ships ~50 internal plugin packages under the
`@deepseek-ai/dsh-*` npm scope. They are the reference implementations and the
building blocks every community plugin extends. Highlights:

- **`deepseek-ai/deepseek-harness`** — the framework and all built-in packages.
  See [`packages/README`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md)
  for the full map: `llm` (model adapters), `shell`/`terminal`/`code-runtime`
  (execution), `fs`/`lsp` (files & language servers), `web` (search/fetch),
  `subagent` (delegation), `plan`, `sandbox`, `hooks`, `skill`, `compaction`,
  `extensions` (runtime self-modifying plugins), and the `web`/`cli` apps.

Everything below is community-built and sits on top of these seams.

## Community plugins

### Web UI & Skins

**中文**：给 DSH 网页界面换肤、加任务看板、宠物、移动端远程等"界面增强"类插件。

- [zhu1090093659/dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) (★300) — Plugin & skin collection for the DSH Web UI: task board, git graph, right-side panel, remote mobile UI, pet, live token stats, skin center.
- [bpc-oss/dsh-web-billing](https://github.com/bpc-oss/dsh-web-billing) (★9) — RMB/USD token billing for the DSH web: official-policy auto pricing (incl. peak/off-peak hours), per-message cost ledger, account balance, local-model savings tracking (¥/$ follows the UI language).
- [Small-tailqwq/dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale) (★56) — "Whale-girl" skin series (maid-atelier), CC BY-NC-SA 4.0.
- [0928OYX/dsh-free-skins](https://github.com/0928OYX/dsh-free-skins) — Free DSH skin plugin: 7 original anime-theme skins, gallery with one-click apply (no restart), per-skin opacity slider, custom fixed chat wallpaper with crop. CC BY-NC-SA 4.0
- [Tommy00748/dsh-theme-cyberpunk2077](https://github.com/Tommy00748/dsh-theme-cyberpunk2077) (★12) — Cyberpunk 2077 / Night City theme: NC yellow × neon cyan, CRT scanlines, Kiroshi hover lock-on, combat-state HUD, synthesized typewriter & message SFX, hidden easter eggs (relic / johnny).
- [fengb3/dsh-theme-aurum](https://github.com/fengb3/dsh-theme-aurum) (★0) — Gilded "aurum" theme: oklch gold dual scheme, dot-matrix canvas, floating-card sidebar; full takeover of sessions / conversation / composer / tool cards with official registrations preserved (disable = stock UI back). Zero-build loader format.
- [Nagi-ovo/dsh-ads](https://github.com/Nagi-ovo/dsh-ads) (★61) — Tongue-in-cheek 2005-style Chinese-site ads in the sidebar / chat feed / popups.
- [alingalingling/ui-status-label](https://github.com/alingalingling/ui-status-label) (★18) — Customize the "deep diving" thinking-status label however you like.
- [omdsh-dev/dsh-genui](https://github.com/omdsh-dev/dsh-genui) (★9) — GenUI: interactive components (layout, charts, mermaid, 3D) rendered inline via the `dsh-ui` fence.
- [vlln/whale-girl](https://github.com/vlln/whale-girl) (★10) — Desktop-pet plugin (QQ-pet style): draggable, feedable, accumulative companion.
- [Sutera-Diffusus/dsh-whale-musume](https://github.com/Sutera-Diffusus/dsh-whale-musume) (★98) — Whale-girl desktop pet for DSH, supporting both the Desktop app (Electron shell, bundled DSH 0.2.0-rc.2) and the Web UI: pat-to-raise growth, per-tool work poses, 90+ artworks, 39 achievements, optional weather companion and MiMo TTS line playback, built-in settings panel; local-first, zero telemetry, 142 unit tests.
- [Nagi-ovo/dsh-visualize](https://github.com/Nagi-ovo/dsh-visualize) (★15) — Generative UI: the model draws interactive HTML cards straight into the chat stream.
- [ZSeven-W/dsh-openpencil](https://github.com/ZSeven-W/dsh-openpencil) (★19) — OpenPencil design preview & editing plugin.
- [omdsh-dev/dsh-annotation](https://github.com/omdsh-dev/dsh-annotation) (★9) — Select text → annotate → send as a message; bubble-hidden annotation blocks.
- [Anionex/dsh-computer-use](https://github.com/Anionex/dsh-computer-use) (★6) — Computer-use plugin for DSH.

- [weibaohui/dsh-settings-ui](https://github.com/weibaohui/dsh-settings-ui) (★0) — Customizes the native DSH settings window: preset/custom sizes, fullscreen, background transparency, and theme/solid-color/image backgrounds, with a floating-ball quick access; saved in the local browser.
- [weibaohui/user-management](https://github.com/weibaohui/user-management) (★0) — Login gate for the dsh web UI: unauthenticated visitors get a login/register page and the first registrant becomes admin; includes user and role management plus login and access audit logs.
- [Iambatman1928/dsh-xingye](https://github.com/Iambatman1928/dsh-xingye) (★0) — Turns a DeepSeek Harness session into a local chat agent: characters and personas, several archive threads per character, an undoable/rewindable local transcript, and an event book.

- [Iambatman1928/dsh-lawagent-ui](https://github.com/Iambatman1928/dsh-lawagent-ui) (★0) — Legal training workbench: three-pane academic UI that reads the "Minglü" (lawagent preset) learning profile (case dossiers, flashcards, wrong-answer book, notes) and sends instructions into a session with one click.

- [PerryLink/dsh-composer-history](https://github.com/PerryLink/dsh-composer-history) (★15) — Terminal-style input history for the web composer: edge-first arrows with exact draft and caret restore, Ctrl+R reverse search and workspace recall.
- [PerryLink/dsh-output-styles](https://github.com/PerryLink/dsh-output-styles) (★7) — Runtime-switchable model output styles with per-session persistence, a style library and system-prompt injection.
- [PerryLink/dsh-session-pin](https://github.com/PerryLink/dsh-session-pin) (★9) — Pin sessions and workspaces to the top of the sidebar with per-pin row colors.
- [PerryLink/dsh-talk](https://github.com/PerryLink/dsh-talk) (★11) — Voice-first session loop: a composer microphone button with speech-to-text, a speak tool for replies, and speak-to-interrupt.
- [QingJ01/dsh-prompt-prediction](https://github.com/QingJ01/dsh-prompt-prediction) (★0) — Codex-style next-prompt prediction for the web composer: after a turn completes, likely next messages appear as ghost text in the empty input; Tab or ArrowRight turns one into an editable draft (undoable, never auto-sent), while Enter keeps DSH submission.

### Terminal & Desktop

**中文**：把 DSH 从网页端带到终端、桌面，或做成独立 App / 启动器。

- [ccch1mneyyy/dsh-cc-tui](https://github.com/ccch1mneyyy/dsh-cc-tui) (★96) — Claude Code-style full-screen TUI: pixel-whale top bar, live status row, streaming thoughts, double-Esc rollback, context bar + TPS meter. One-line npm install.
- [huiliyi37/dsh-tianshu-tui](https://github.com/huiliyi37/dsh-tianshu-tui) (★53) — DSH terminal UI.
- [chen-001/dsh-grok-tui](https://github.com/chen-001/dsh-grok-tui) (★5) — Grok-style TUI.
- [hust-open-atom-club/oh-dsh-desktop](https://github.com/hust-open-atom-club/oh-dsh-desktop) (★46) — Extensible macOS workbench: native PTY, workspace tools, live bilingual plugins, isolated-preview plugin marketplace.
- [Ruler4396/dsh-launcher](https://github.com/Ruler4396/dsh-launcher) (★9) — Lightweight Windows launcher: silent logon autostart + a minimal WebView2 window instead of a full browser.
- [bitterSmilezzz/dsh-mac-desktop](https://github.com/bitterSmilezzz/dsh-mac-desktop) (★1) — macOS desktop wrapper.
- [hanelalo/browser-bridge](https://github.com/hanelalo/browser-bridge) (★17) — Let your agent drive your real browser window like you would.
- [Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser) (★16) — Chrome sidebar extension so DSH operates your browser directly, no vision needed.
- [whiteguo233/dsh-openbiliclaw](https://github.com/whiteguo233/dsh-openbiliclaw) (★4) — Bilibili integration for DSH.
- [vvlife/deepseek-harness-desktop](https://github.com/vvlife/deepseek-harness-desktop) — Self-contained macOS app: bundles the Node runtime + full dsh + full Paseo (daemon + Web UI + mobile pairing) into one APP — drag to Applications and go, zero pre-install. Mobile QR pairing, WhaleHub plugin marketplace, built-in HTML preview, one-click public deploy; isolated from any dsh/Paseo already on your machine.

- [Zhuchen00123/dsh-wsl-modes](https://github.com/Zhuchen00123/dsh-wsl-modes) (★1) — DSH WSL presets: minimal-wsl + code-wsl with WSL Linux bash + bwrap sandbox and anchored bootstrap.

- [PerryLink/dsh-click](https://github.com/PerryLink/dsh-click) (★10) — Native desktop control (Windows first): screen capture, read, click, type, scroll and app launch, approval-gated and never stealing focus.

### Vision & Multimodal

**中文**：让纯文本模型也能"看图"：图像问答、长截图 OCR、UI 还原、像素比对等。

- [Anionex/dsh-vision-toolkit](https://github.com/Anionex/dsh-vision-toolkit) (★106) — Vision toolkit for text-only models: intent-aware image Q&A, long-screenshot OCR, UI restoration, grounding, pixel diff, Artifacts, Web UI.
- [windyslime/DeepSee](https://github.com/windyslime/DeepSee) (★1) — DSH `0.1.0-rc.5` Web-profile vision integration: image turns go through a local DeepSee gateway with pluggable VLM backends while normal text routing stays in DSH.
- [zhouwumu2-lab/dsh-vision-fix](https://github.com/zhouwumu2-lab/dsh-vision-fix) (★10) — Vision fix / repair helper.
- [sjscy05/deepseek-harness-vision-plugin](https://github.com/sjscy05/deepseek-harness-vision-plugin) — Vision plugin for DSH.
- [good-boy4069/Deepseek-omnimodal](https://github.com/good-boy4069/Deepseek-omnimodal) (★2) — Omnimodal support.
- [YYTbit/dsh-plugin-vision-toolkit](https://github.com/YYTbit/dsh-plugin-vision-toolkit) — Vision-toolkit bridge.

- [PerryLink/dsh-draw](https://github.com/PerryLink/dsh-draw) (★8) — Unified static-image generation: one image_generate tool with config-driven engine routing and health-aware fallback.

### Tools & Editor UX

- [SoloPup Memory](https://github.com/OakcoderX/solopup-memory) — Source-linked text memory for DSH with project scopes and revision history (public beta). ★0. Install: `dsh plugin --profile desktop add solopup-memory@0.21.0-beta.2 --ignore-scripts`.
- [Zhangbo-cn/dsh-voice-input-plugin](https://github.com/Zhangbo-cn/dsh-voice-input-plugin) (★6) — Composer mic for the Web UI: tap-to-monitor live transcription and hold-to-talk, with host Edge TTS reply reading that streams while the model generates, echo-pause during reading, and tap-to-stop.

**中文**：编辑器体验增强、`@file` 引用、消息分支编辑、会话回滚等"好不好用全靠它"的小工具。

- [omdsh-dev/dsh-at-file](https://github.com/omdsh-dev/dsh-at-file) (★21) — Codex-style `@file` mentions: search workspace files in the composer and attach their contents to prompts.
- [omdsh-dev/dsh-custom-tool](https://github.com/omdsh-dev/dsh-custom-tool) (★17) — Create & manage sandboxed JavaScript tools with a Monaco editor and model-driven tool lifecycle.
- [Moeblack/dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) (★9) — Branch-based message editing, reroll, retry, version timeline.
- [Anionex/dsh-turn-rewind](https://github.com/Anionex/dsh-turn-rewind) (★16) — Rewind conversation + workspace state via a persistent Change Ledger.
- [Electricitysheep/dsh-tool-turbo](https://github.com/Electricitysheep/dsh-tool-turbo) (★1) — Tool turbo.
- [LingLambda/dsh-undo](https://github.com/LingLambda/dsh-undo) (★1) — Undo support.
- [fakechris/dsh-track](https://github.com/fakechris/dsh-track) (★1) — Tracking helper.
- [omdsh-dev/dsh-plugin-skills](https://github.com/omdsh-dev/dsh-plugin-skills) (★1) — Skills plugin.
- [leechen298/Code2Skill](https://github.com/leechen298/Code2Skill) (★4) — Generates Function, MCP, Agent Skill, and offline test packages from existing code as an installable DSH bundle.
- [omdsh-dev/dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) (★1) — Mnemonics plugin.
- [ArtificialNotImbecile/dsh-context-taxonomy](https://github.com/ArtificialNotImbecile/dsh-context-taxonomy) — Context taxonomy.
- [delef/dsh-free-web-search](https://github.com/delef/dsh-free-web-search) (★0) — Free web search with 10 engines (Bing/DuckDuckGo/SearXNG/AnySearch free + Exa/Tavily/Keenable/Perplexity/DeepSeek paid), automatic fallback chain, time-filtered advanced search, platform search (GitHub/Reddit), web page fetching, LRU caching, and a settings UI. No API keys required.
- [zyfgood/dsh-web-search-tavily](https://github.com/zyfgood/dsh-web-search-tavily) (★0) — Tavily-backed `web_search` provider for DSH: swaps the DeepSeek-cloud default (one full model call per search) for the Tavily API (free 1000 credits/month), with sticky multi-key rotation on 401/429/5xx, `env:`-referenced secrets, and an auto-mounted bundle patch that flips `searchProvider` to `tavily`. Install: `dsh plugin add github:zyfgood/dsh-web-search-tavily#main&path:/`.
- [chidaic/dsh-light-memory](https://github.com/chidaic/dsh-light-memory) (★1) — Lightweight memory plugin: four Markdown files (USER/PROJECT/WORKLOG/CONVENTION) with append/distill actions, zero external parts, prefix-cache-friendly dual-layer injection; `dsh plugin --profile web add dsh-light-memory`.
- [weibaohui/dsh-file-share](https://github.com/weibaohui/dsh-file-share) (★1) — Session workspace file manager: adds a "Files" tab to the conversation area to browse the current session workspace directory tree and manage it in place (upload, download, mkdir, rename, delete, search), with files mentionable into the composer for the agent to process.

- [PerryLink/dsh-library](https://github.com/PerryLink/dsh-library) (★10) — Local document knowledge base: add, list and search a workspace library with hybrid semantic and keyword retrieval, diversity re-ranking and citation-aware injection over a local SQLite index, with no model downloads.

- [Iambatman1928/dsh-lawkb-ui](https://github.com/Iambatman1928/dsh-lawkb-ui) (★0) — Legal knowledge-base workbench: hybrid keyword/statistical/vector retrieval over local statute .doc/.docx corpora, faceted filtering, charge-name and civil-cause trees, a document editor, and AI tools (citation check, contract review, analysis, drafting).

- [PerryLink/dsh-lsp-actions](https://github.com/PerryLink/dsh-lsp-actions) (★20) — LSP action surface over real language servers: diagnostics, formatting, completion, code actions, symbols and rename.
- [PerryLink/dsh-translate](https://github.com/PerryLink/dsh-translate) (★8) — Vendor parameter translation across eleven vendors plus deterministic repair of broken JSON tool output.
- [PerryLink/dsh-mask](https://github.com/PerryLink/dsh-mask) (★8) — PII masking at the model boundary: names, phones, emails, cards and keys become placeholders, restored only in the display layer.
- [PerryLink/dsh-data-quality](https://github.com/PerryLink/dsh-data-quality) (★33) — Deterministic data profiling, cleaning and verification with a scorecard, content-hash dedupe and drift checks.
- [PerryLink/dsh-doublecheck](https://github.com/PerryLink/dsh-doublecheck) (★36) — Engineering-discipline guard: grill the requirements, test the implementation, prove the delivery, then decide ship or rework.
- [PerryLink/dsh-budget](https://github.com/PerryLink/dsh-budget) (★10) — Cost governance: token and cost metering per model, session and day, budget caps with alerts, carbon estimation and latency benchmarks.
- [PerryLink/dsh-fast](https://github.com/PerryLink/dsh-fast) (★6) — Read-only performance diagnostics: load and restore timing, compaction, context-injection volume and LLM cache hit rate.
- [PerryLink/dsh-observe](https://github.com/PerryLink/dsh-observe) (★7) — OpenTelemetry and Langfuse export: turn, step, tool and LLM spans with token and cost metrics.
- [PerryLink/dsh-memento](https://github.com/PerryLink/dsh-memento) (★106) — Bounded, layered and approval-gated cross-session memory over a local SQLite provider, with a memory tool and snapshot injection.
- [PerryLink/dsh-fund-research](https://github.com/PerryLink/dsh-fund-research) (★44) — Deterministic research reports for Chinese public mutual funds, with sealed and traceable source snapshots.
- [PerryLink/dsh-industry-research](https://github.com/PerryLink/dsh-industry-research) (★138) — Industry and company research pack: chain mapping, policy and news tracking, research cards and auditable reports.
- [PerryLink/dsh-research-report](https://github.com/PerryLink/dsh-research-report) (★134) — Verifiable research reports: a content-addressed evidence ledger binds every claim to a snapshot.
- [PerryLink/dsh-skill-pack-security](https://github.com/PerryLink/dsh-skill-pack-security) (★13) — Security-audit skill pack plus the plugin_vet supply-chain scanner: secret scan, dependency audit and prompt-injection review.
- [dhicoc/dsh-reverse-skill](https://github.com/dhicoc/dsh-reverse-skill) (★246) — Reverse-skill pack (88 SKILL.md) packaged as a DeepSeek Harness Cordis plugin: reverse engineering, authorized pentesting and security-research skill router.
- [weibaohui/dsh-dashboard](https://github.com/weibaohui/dsh-dashboard) (★0) — Usage dashboard: offline-scans session logs to chart daily/weekly/monthly tokens, estimated costs, model/tool/skill/command leaderboards, output speed, working hours and quality metrics; gridstack+ECharts cards are drag-and-drop composable, with custom formulas and AI arrangement (prompt round-trip import).
- [siweina/dsh-novel-writer](https://github.com/siweina/dsh-novel-writer) (★18) — A local workbench for Chinese web-novel writers: a pre-draft chapter brief gathers the previous hand-off, outline, character cards, unresolved plot threads and language rules; after drafting, a six-dimension prose baseline drives a quantified self-check and a prioritised revision plan with original line numbers; across chapters it reports plot-thread spans, characters missing too long and outline drift. All analysis runs on a bundled 24MB Chinese model on-device — zero API cost, the manuscript never leaves the machine; 18 tools, also shipped as an MCP server for Claude Desktop / Cursor.
- [mubaid/dsh-fluent-korean](https://github.com/mubaid/dsh-fluent-korean) (★0) — Switchable Korean output styles: the plugin registers its own system-prompt section asking the model for natural Korean prose, with a second style that drops the coding guidance. The rules are snflkd/fluent-korean, carried over byte-identically under MIT. Install: `dsh plugin add mubaid/dsh-fluent-korean`.
- [hxlog/dsh-mcp-tools](https://github.com/hxlog/dsh-mcp-tools) (★2) — MCP server and tool manager for DSH Settings: add streamable-http or stdio servers, Postman-style header rows, connectivity test, and per-tool switches so disabled tools never reach the model. Install: `dsh plugin add dsh-mcp-tools`
- [WJDdidi-1/ai-context-doctor](https://github.com/WJDdidi-1/ai-context-doctor) (★1) — Grades what a repository or a past session actually read, warns before it floods the context window, and writes the `.aiignore` rules that stop the worst of it; the sidebar panel follows the current conversation.


- [hxlog/dsh-skills-tools](https://github.com/hxlog/dsh-skills-tools) (★1) — Skills manager for DSH settings: import Agent Skills from Git repositories, group them by repository, toggle each skill, and expand SKILL.md content. Disabled skills stay out of the model context.

### Agent orchestration & Workflow

**中文**：多 Agent 团队、可治理的工作流、会话蒸馏等"把一次性调度变成工程资产"的编排类插件。

- [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) (★30) — AgentTeams plugin for DSH.
- [icetomoyo/dsh_workflow](https://github.com/icetomoyo/dsh_workflow) (★29) — Brings Claude Code's UltraCode to DSH; turns one-shot multi-agent dispatch into a generatable / savable / governable / observable / recoverable Workflow layer.
- [btspoony/mstar-harness](https://github.com/btspoony/mstar-harness) (★38) — Skill-driven Harness / Loop Engineering Workflow Agent Plugin.
- [LoserFox/distill](https://github.com/LoserFox/distill) (★11) — Automatic conversation distillation: background subagent reflection + skill create/update.
- [titanwings/dsh-plannotator](https://github.com/titanwings/dsh-plannotator) (★1) — Plan annotator.
- [yyh-001/dsh-companion](https://github.com/yyh-001/dsh-companion) (★2) — Companion plugin.
- [vibeinging/dsh-work](https://github.com/vibeinging/dsh-work) (★2) — Work plugin.
- [omdsh-dev/dsh-gomoku](https://github.com/omdsh-dev/dsh-gomoku) (★5) — Gomoku game plugin.
- [ZK-Andy/dsh-continual-evolve](https://github.com/ZK-Andy/dsh-continual-evolve) (★11) — Continual self-evolution: versioned, auditable, rollback-safe harness state (prompt notes, memories, skills, subagent specs) refined from session trajectories.
- [bpc-oss/dsh-routed-subagent](https://github.com/bpc-oss/dsh-routed-subagent) (⭐0) — Run a one-shot subagent fully mounted on any agent preset from any session, with per-call model/provider override, model pre-check, and external CLI engines (codex / claude / codebuddy) with background jobs, live progress, kill, and continuable sessions.
- [bpc-oss/dsh-fork-to-preset](https://github.com/bpc-oss/dsh-fork-to-preset) (⭐0) — Fork any session into a different agent preset from the conversation header: a preset picker creates a new child session mounted on the chosen preset, inheriting the source session's completed turns.

**DSH skill bundles (satan9394) — 207 skills in one monorepo**：原 20 个中文 skill 包已扩展并统一合并进单一仓库 [satan9394/dsh-skills-bundle](https://github.com/satan9394/dsh-skills-bundle)，共 207 个 skill 型插件（`skills/<name>/SKILL.md` 经 `ctx.skills` 注册），覆盖 12 大分类：工程方法论 / API & 架构 / 前端 & UI / 后端 & DevOps / AI & ML / 安全 & 合规 / 写作 & 沟通 / 测试 / 数据 & 分析 / 产品 & 设计 / 效率 & 工具 / 生活 & 趣味。仓库带 `dsh-plugin` topic，可按需单独安装任意插件：

- [satan9394/dsh-skills-bundle](https://github.com/satan9394/dsh-skills-bundle) — 207 DSH skill plugins in one monorepo (12 categories); install any single plugin via `github:satan9394/dsh-skills-bundle#path:plugins/<name>`.

- [nortejiang-tech/dsh-req-miner](https://github.com/nortejiang-tech/dsh-req-miner) (★0) — Requirements-mining sidebar plugin: per-session floating interview window driven by a continuable subagent (decision tree + frontier questions), reads the bound session's workspace and recent context, one-click return of the summarized requirement prompt to the composer. Install: `github:nortejiang-tech/dsh-req-miner`.

- [weibaohui/hermes-loop](https://github.com/weibaohui/hermes-loop) (★0) — Automatic post-conversation retrospective that distills useful experience into reusable skills for the skill library, with approval mode and skill-library governance (archive/restore).
- [weibaohui/dsh-continue](https://github.com/weibaohui/dsh-continue) (★0) — Auto-resume for interrupted agent sessions: rules route by failure type (rate limit, quota, auth, context overflow, crashed orphan) into backoff retry, model switch, resume-after-compaction, or stop-loss notification, with a visual rule editor.
- [weibaohui/dsh-tasks](https://github.com/weibaohui/dsh-tasks) (★0) — Scheduled tasks: run a prompt on cron schedules, each run opens a new agent session to do the work, with workspace binding, manual run, session auto-naming, and a fullscreen task management page.
- [weibaohui/experts-management](https://github.com/weibaohui/experts-management) (★0) — Expert manager: manage ntd-format experts and expert teams (plugin.json + Agent MD + skill sets), browse and install from a built-in market of 50+ experts, and run tasks in an expert persona via `/expert-<name>` without consuming model directory tokens.
- [weibaohui/context-razor](https://github.com/weibaohui/context-razor) (★0) — Context trimmer: lists the current session's context entries with role, preview and ≈token estimate (cl100k), highlights over-threshold items, and removes selected entries exactly without LLM summarization.
- [zuoyunlai/lunheng-article-pipeline-dsh](https://github.com/zuoyunlai/lunheng-article-pipeline-dsh) (★4) — Long-form writing pipeline skill bundle: 9 independent roles T1-T9 across 6 phases — parallel literature/data/case retrieval, triangular evidence verification, a 23-check M-gate, a G0-G14 audit, peer-review scoring with journal matching, 4 human checkpoints — shipping role cards, templates and 11 zero-dependency verification scripts. Install: `dsh plugin add lunheng-article-pipeline`.
- [weibaohui/dsh-process](https://github.com/weibaohui/dsh-process) (★1) — Process management: brings ntd-style processes (multi-stage, multi-step agent workflow templates) into the dsh web UI — browse, edit, validate, import/export and AI-generate processes; the built-in library is read-only while the personal library is writable with live file sync, and agents read the library through process_* tools and advance work stage by stage.

- [PerryLink/dsh-auto-review](https://github.com/PerryLink/dsh-auto-review) (★187) — Second-model AI auto-review on the approval chain: a read-only reviewer subagent returns structured allow/deny verdicts with reasons, fail-closed by default and fully auditable from the session log.

- [PerryLink/dsh-autotier](https://github.com/PerryLink/dsh-autotier) (★0) — Automatic strong/cheap model-tier routing with intent gating, plan-mode handoff and failure escalation.
- [PerryLink/dsh-background-agents](https://github.com/PerryLink/dsh-background-agents) (★16) — Durable continuable child agents: watch progress in the sidebar, message them any time and interrupt.
- [PerryLink/dsh-team-rooms](https://github.com/PerryLink/dsh-team-rooms) (★1) — Persistent shared rooms across independent sessions: a message bus, a shared task board and a timeline.
- [PerryLink/dsh-permission-rules](https://github.com/PerryLink/dsh-permission-rules) (★112) — Declarative ordered allow/deny/ask rules matching tool names, arguments, workspace paths and network targets.
- [PerryLink/dsh-defend](https://github.com/PerryLink/dsh-defend) (★16) — Prompt-injection, jailbreak and secret-leak defense with allow/ask/block interception and sanitized audit events.
- [yyfdfsyyf-source/dsh-hard-gate](https://github.com/yyfdfsyyf-source/dsh-hard-gate) (★0) — Independent permission gate above the built-in sandbox: blocks writes outside the workspace and to protected paths even under danger-full-access, refuses whole-file `write` without a complete fresh read (interval union to EOF), and keeps ZIP restore points plus Recycle Bin copies before deletes and overwrites.
- [PerryLink/dsh-laya](https://github.com/PerryLink/dsh-laya) (★1) — Laya typed decisions (`noul` yes/no, `choice`, `score`) as a first-class Cordis service plus the model-visible `laya_ask` and `laya_plan` tools; the plugin installs and downloads nothing and talks to a `laya-mcp serve` sidecar you start yourself.

- [weibaohui/dsh-flow](https://github.com/weibaohui/dsh-flow) (★0) — Execution flow chart: renders the current session's execution as a vertical node flow (turns, user, assistant, tools, approvals, retries, compaction), appended in real time over SSE with auto-follow scrolling, so the chart draws wherever the session executes.
- [weibaohui/dsh-thinktank](https://github.com/weibaohui/dsh-thinktank) (★0) — Think tank: a built-in library of 161 classic mental models (decision/strategy/cognition/psychology/communication/learning/system/innovation/execution) — enter one question and several selected models analyze it in parallel via AI, producing a synthesized report with consensus, disagreements, blind spots and an action checklist; supports both automatic analysis and prompt round-trip import.
- [yyfdfsyyf-source/dsh-context-fold](https://github.com/yyfdfsyyf-source/dsh-context-fold) (★2) — Context folding: spills oversized tool results to on-disk copies with deterministic head/tail markers, keeps a searchable ledger of compaction summaries, and extracts cross-session memories scoped per project; folded content is restored byte-for-byte through one tool call.
- [lijiaqi-AI-Product-Manager/dsh-agent-compare](https://github.com/lijiaqi-AI-Product-Manager/dsh-agent-compare) (★27) — Compare two running Vite implementations in DSH conversations, choose blind, and review adoption against current project edits.


### Integrations & Bridges

**中文**：把 DSH 接到 VS Code、桌面通知、或其它 Agent（Claude / Codex / Pi / OpenCode）的桥接类插件。

- [PandaPolo/dsh-voice-call](https://github.com/PandaPolo/dsh-voice-call) (★1) — Agent-initiated voice calls: `offer_call` rings the human (接听/拒接/稍后再说), accepted calls synthesize and play locally via CrispASR + Qwen3-TTS (9 speakers, 2 Chinese dialects), rejected calls return the decision to the agent.
- [omdsh-dev/dsh-open-in-vscode](https://github.com/omdsh-dev/dsh-open-in-vscode) (★28) — Open workspace directories in VS Code directly from the web GUI.
- [omdsh-dev/dsh-notification](https://github.com/omdsh-dev/dsh-notification) (★19) — Desktop notifications for turn completions, with per-outcome controls and include/exclude keyword rules.
- [Nagi-ovo/dsh-find-plugins](https://github.com/Nagi-ovo/dsh-find-plugins) (★12) — In-app plugin finder.
- [YYTbit/dsh-plugin-claude-bridge](https://github.com/YYTbit/dsh-plugin-claude-bridge) — Bridge to Claude.
- [YYTbit/dsh-plugin-codex-bridge](https://github.com/YYTbit/dsh-plugin-codex-bridge) — Bridge to Codex.
- [YYTbit/dsh-plugin-pi-bridge](https://github.com/YYTbit/dsh-plugin-pi-bridge) — Bridge to Pi.
- [YYTbit/dsh-plugin-opencode-bridge](https://github.com/YYTbit/dsh-plugin-opencode-bridge) — Bridge to OpenCode.
- [busabase/busabase-dsh-plugin](https://github.com/busabase/busabase-dsh-plugin) (★5) — Connects DSH to a local or cloud Busabase knowledge base and database: search approved knowledge and propose structured-data changes for human review. Install: `dsh plugin --profile web add @busabase/dsh-plugin`.
- [bobleer/deepseek-harness-plugin-mcp](https://github.com/bobleer/deepseek-harness-plugin-mcp) — MCP plugin.
- [labmimors/dsh-mcp-lens](https://github.com/labmimors/dsh-mcp-lens) (★5) — Progressive-disclosure MCP gateway for DSH: search remote tools, inspect exact input schemas on demand, then call an explicit server/tool pair.
- [yoke233/dsh-openai-codex-auth](https://github.com/yoke233/dsh-openai-codex-auth) (★1) — OpenAI Codex auth.
- [vvlife/dsh-agnes-paseo](https://github.com/vvlife/dsh-agnes-paseo) — Agnes AI model gateway (OpenAI-compatible) for dsh, plus a zero-dependency ACP bridge that registers DeepSeek Harness as a Paseo provider.
- [nickhelion/dsh-qwen-token-plan-cn-responses](https://github.com/nickhelion/dsh-plugins/tree/main/packages/qwen-token-plan-cn-responses) (★0) — Qwen Token Plan CN Personal Responses API provider: official model/tool catalog sync, server-side web/code/extraction/image tools, DSH local functions, and image input.
- [nickhelion/dsh-serverchan-notify](https://github.com/nickhelion/dsh-plugins/tree/main/packages/serverchan-notify) (★0) — ServerChan3 (Server酱) push notifications when an agent turn finishes — title, model, project directory, git branch, status and a reply excerpt, with subagent filtering and fire-and-forget delivery.
- [vvlife/dsh-paseo-mobile](https://github.com/vvlife/dsh-paseo-mobile) — Connect your phone to dsh via Paseo: one-command setup registers dsh as a Paseo provider (zero-dependency ACP bridge), then scan the pairing QR in the Paseo mobile app. Model-agnostic: follows your existing dsh model config; mirrors dsh web sessions to the phone with context-aware follow-ups.

- [SwainGao/dsh-plugin-ai-bridge](https://github.com/SwainGao/dsh-plugin-ai-bridge) (★1) — Bridge to external AI models (Codex / Claude / GPT / OpenAI-compatible relays) for read-only second-opinion code review, adversarial review, task delegation with resume threads, and non-blocking background jobs. `dsh plugin add dsh-plugin-ai-bridge@0.1.3`.

- [Nwflower/dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) (★54) — Import Claude Code / Codex / ChatGPT / Cursor chat histories as resumable DeepSeek Harness sessions.
- [zyfgood/dsh-feishu-bot](https://github.com/zyfgood/dsh-feishu-bot) — Bridge a Feishu/Lark bot into DSH over the official WebSocket long connection (no public callback URL): echo/llm/agent reply modes with live streaming, mid-task steer questions, /attach GUI-session takeover, and feishu_* outbound tools. 飞书机器人接入：长连接免公网回调、agent 流式回复、任务执行中提问、/attach 接管 GUI 会话。
- [weibaohui/dsh-webdav-server](https://github.com/weibaohui/dsh-webdav-server) (★1) — WebDAV server: turns a shared directory into a WebDAV service that Windows, macOS and Linux can mount as a local disk, with token authentication, optional read-only mode, configurable directory/port/token, and per-platform mounting guides built into the settings page.
- [weibaohui/dsh-git-server](https://github.com/weibaohui/dsh-git-server) (★1) — Git server: embeds ts-gogs (a TypeScript reimplementation of Gogs) and serves a full Git service on its own port — HTTP clone/push, web UI, issues/PRs/wiki — reusing user-management credentials, start/stop from the settings page.
- [weibaohui/dsh-sync](https://github.com/weibaohui/dsh-sync) (★3) — Multi-machine sync: keeps multiple dsh replicas consistent through one private GitCode repository — skills, sessions, settings and plugin manifests each with an independent switch; changes go through branch, PR and merge, remote-only additions are pulled back before every push so nothing is deleted, and an AI smart-align step semantically merges files both sides changed (plus one-click conflict resolution); private repos enforced, pull never overwrites local edits.

- [PerryLink/dsh-cert-mcp](https://github.com/PerryLink/dsh-cert-mcp) (★0) — Read-only MCP server over the DSH plugin-certification registry: query a plugin certification grade, its snapshot and the five-dimension evidence behind it.
- [PerryLink/dsh-github](https://github.com/PerryLink/dsh-github) (★15) — Official-grade GitHub integration: a composite action.yml, a PR review bot with idempotent inline comments and a status-check gate, plus PR, issue, repository and file tools with every write gated by human approval.
- [PerryLink/dsh-mcp-panel](https://github.com/PerryLink/dsh-mcp-panel) (★61) — Management console for the official DSH MCP client: a /mcp command with health diagnostics, a Settings tab with approval-gated server CRUD and automatic backups, and a trial console over the official tool pipeline.
- [PerryLink/dsh-ticktick](https://github.com/PerryLink/dsh-ticktick) (★0) — TickTick (Dida365) task bridge: a session-header task panel with filtering, search and drag reordering, eleven curated agent tools and a settings card, over the official TickTick MCP endpoint.

- [PerryLink/dsh-claude-move](https://github.com/PerryLink/dsh-claude-move) (★25) — Four-source migration wizard: move Claude Code, Codex, OpenCode and Hermes sessions, memories and skills into DSH.
- [PerryLink/dsh-session-sync](https://github.com/PerryLink/dsh-session-sync) (★11) — Cross-device session sync over a dedicated git mirror with append-only, keep-both conflict resolution.
- [PerryLink/dsh-local-ai](https://github.com/PerryLink/dsh-local-ai) (★13) — Ollama integration: discover, pull and route to local models by task type, with automatic fallback to the cloud.
- [PerryLink/dsh-reach](https://github.com/PerryLink/dsh-reach) (★0) — Mirrors approval and question cards to IM chat (WeChat iLink first) and answers them from chat, with a session console.
- [mubaid/dsh-opencode-freeaccess](https://github.com/mubaid/dsh-opencode-freeaccess) (★0) — Puts the DSH conversation session id on outgoing requests so OpenCode's free tier accepts them, by listening on the `llm/stream` waterfall and injecting the session header family onto requests to opencode hosts. Non-opencode hosts are left alone; no API key needed. Install: `dsh plugin --profile web add github:mubaid/dsh-opencode-freeaccess`.
- [radres/dsh-plugin-call-me](https://github.com/radres/dsh-plugin-call-me) (★8) - Rings your real phone: `call_me` and `text_me` tools, plus optional turn-end and approval calls whose spoken answer is transcribed back into the run. Needs the /call-me phone app (iPhone or Android, paid). Install: `dsh plugin --profile web add github:radres/dsh-plugin-call-me`.

### Sidebar, Workspace & Ecosystem

**中文**：侧边栏工作台、`oh-my-dsh` 这类"插件库"、插件脚手架与注册表等生态基础设施。

- [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) (★66) — Full workbench sidebar with third-party tab registration: file render/edit, terminal, Git, subagent.
- [sandbaseai/dsh-plugin-store](https://github.com/sandbaseai/dsh-plugin-store) (★1) — Native Store for DSH Settings: live catalog search, tag filters, ranking, runtime-verified installation, and installed-plugin inventory.
- [LaplaceYoung/oh-my-dsh](https://github.com/LaplaceYoung/oh-my-dsh) (★12) — Plugin ecosystem: 700+ plugins wired only through extension seams, no agent-loop changes.
- [kingjly/dsh-plugin-builder](https://github.com/kingjly/dsh-plugin-builder) (★1) — Plugin builder scaffolding.
- [vlln/plugin-registry](https://github.com/vlln/plugin-registry) (★6) — Plugin registry.
- [DeKrych/Dshell-plugins](https://github.com/DeKrych/Dshell-plugins) (★27) — Dshell plugin collection.
- [HackSing/dsh-plugins](https://github.com/HackSing/dsh-plugins) / [Yihong89/dsh-plugins](https://github.com/Yihong89/dsh-plugins) — Plugin collections.
- [coppynight/dsh-doctor](https://github.com/coppynight/dsh-doctor) (★2) — Diagnostics / doctor.
- [yyh-001/dsh-expression](https://github.com/yyh-001/dsh-expression) (★1) — Expression plugin.
- [Chinesezjc/dsh-interconnect](https://github.com/Chinesezjc/dsh-interconnect) (★8) — Cross-instance message/event handoff.
- [weibaohui/skills-management](https://github.com/weibaohui/skills-management) (★1) — Skill marketplace and manager: manage skills from all local coding agents (10+ executors, incl. Claude Code and Codex) in one page and import them into the DSH skill library; built-in market of 6600+ skills, per-skill token-overhead stats, and model visibility control.
- [weibaohui/dsh-smart-title](https://github.com/weibaohui/dsh-smart-title) (★0) — Smart session titles for DSH: after each conversation turn an independent auxiliary LLM call summarizes the full user+assistant transcript into a title that follows the session's real topic instead of echoing the first message; the first message is titled instantly, failed built-in titles auto-retry on later turns, manual renames are never overwritten, and subagent/fork sessions are skipped.
- [weibaohui/dsh-fde-tools](https://github.com/weibaohui/dsh-fde-tools) (★0) — FDE toolbox bundle: installing this one plugin pulls in a curated set of common dsh plugins (git server, WebDAV mount, knowledge base, scheduled tasks, auto-resume, UI tweaks, auto-retrospection, file manager, smart titles, task board, plugin market, context trimmer, IM bridge, sidebar enhancements), with a panel showing install status and one-click gap-filling.
- [weibaohui/dsh-kb](https://github.com/weibaohui/dsh-kb) (★1) — Team knowledge base for offline knowledge sharing (FDE box scenario): browse, full-text search and refinement entry points; raw material is queued automatically and distilled into wiki pages by a serial bot session (Karpathy LLM Wiki pattern: immutable raw, two-step refinement, log stream, monthly lint).

- [PerryLink/dsh-plugin-doctor](https://github.com/PerryLink/dsh-plugin-doctor) (★0) — Zero-dependency detector for DSH plugins: package-structure checks, cordis contract scanning, a keyless headless sandbox smoke run and ecosystem-listing verification in one pass.
- [PerryLink/dsh-plugin-upgrade](https://github.com/PerryLink/dsh-plugin-upgrade) (★0) — Upgrade skill for DSH plugin authors: one package carries one corridor index that reads the caller peer range and routes it to the matching closed corridor card, plus a zero-dependency seam scanner.

- [PerryLink/dsh-plugin-guide](https://github.com/PerryLink/dsh-plugin-guide) (★40) — The plugin-development knowledge base as an installable agent skill: official docs, a Cordis primer and community pitfalls.
- [PerryLink/dsh-plugin-kit](https://github.com/PerryLink/dsh-plugin-kit) (★0) — Shared zero-runtime-dependency toolkit for plugin authors: a provider registry seam, approval gates and a new-plugin skeleton.
- [PerryLink/dsh-score](https://github.com/PerryLink/dsh-score) (★6) — Multi-dimensional plugin quality scoring, every conclusion backed by real CLI evidence.
- [PerryLink/dsh-test-drive](https://github.com/PerryLink/dsh-test-drive) (★9) — Isolated install-and-smoke test drives in a throwaway profile, with a structured pass/fail matrix.
- [PerryLink/dsh-checkpoint-rewind](https://github.com/PerryLink/dsh-checkpoint-rewind) (★18) — Session, workspace and config checkpoints with one-shot /rewind rollback and a timeline of pairwise diffs.
- [PerryLink/dsh-hidden-risk-map](https://github.com/PerryLink/dsh-hidden-risk-map) (★0) — Safety-hazard register to regulation mapping: cites the clause of China's major-accident hazard standard (MEM Order No. 10) behind each entry, flags differences only.
- [PerryLink/dsh-hazchem-check](https://github.com/PerryLink/dsh-hazchem-check) (★0) — Hazardous-chemical register check: recomputes stored quantity against the GB 18218-2018 threshold quantities for major-hazard installation identification, flags differences only.
- [PerryLink/dsh-ppap-check](https://github.com/PerryLink/dsh-ppap-check) (★0) — PPAP submission check: verifies element completeness and version fields against the PPAP manual and the declared submission level, flags differences only.
- [PerryLink/dsh-aqua-input-check](https://github.com/PerryLink/dsh-aqua-input-check) (★0) — Aquaculture input register check: verifies the register's own completeness and date arithmetic (pond and species named, quantity and use date recorded, harvest respecting the withdrawal period the record itself states, stocking records carrying source and quarantine certificate number, configured input vocabulary, unique batch numbers), flags differences only.
- [PerryLink/dsh-archive-check](https://github.com/PerryLink/dsh-archive-check) (★0) — Filing-register check: holds a 归档登记表 to what it can be held to mechanically (configured description fields present, unique 档号, gapless 件号, 保管期限 from your own schedule, parseable 形成日期 matching the register year, items past the configured transfer deadline surfaced), flags differences only.
- [PerryLink/dsh-bid-ca-precheck](https://github.com/PerryLink/dsh-bid-ca-precheck) (★0) — Bid compliance pre-check: applies a versioned rule pack to a 投标符合性响应台账 and verifies every tender requirement has a recorded response, verdicts come from your configured vocabulary, clause numbers are unique, the register declares project and bidder, high-risk clauses carry evidence, and the requirement column still holds real requirements rather than template placeholders, flags differences only.
- [dsh-version-guard](https://github.com/skyjjgw/dsh-version-guard) — Snapshots plugin versions and profile configuration, with an independent recovery page to restore a known-good configuration when DSH cannot start. ⭐1
- [weibaohui/dsh-favorites](https://github.com/weibaohui/dsh-favorites) (★1) — Session favorites: bookmark any conversation into a browser-style favorites panel — one-click star from session rows, folders for organization, notes, custom display names, resume session, fork into a new session, basic session stats, plus a fork-relationship graph showing how conversations derive from one another.
- [weibaohui/dsh-sidebar-tidy](https://github.com/weibaohui/dsh-sidebar-tidy) (★0) — Sidebar tidy: when plugins pile up, the rows under 'New session' get crowded with panel and plugin entries. This plugin folds them all — global panel rows, plugin-injected entry rows (own and third-party alike), and bottom entries — into a single menu button whose secondary menu triggers each entry exactly as before; keep any entry permanently visible with a name whitelist, and the button turns into an icon when the sidebar collapses to a narrow rail.
- [WJDdidi-1/dsh-plugin-toolkit](https://github.com/WJDdidi-1/dsh-plugin-toolkit) (★1) — Preflight for plugin authors: packs the plugin the way npm would, installs the tarball, imports the root export the loader mounts and mounts the panel, so a plugin the host would drop fails before release; also `init`, `dev` and `release`.
- [WJDdidi-1/dsh-plugin-example](https://github.com/WJDdidi-1/dsh-plugin-example) (★0) — A ~70-line plugin to copy from: one sidebar tab, a host half, a bundle manifest and a passing preflight.



### Fun & Misc

**中文**：合影墙、音乐、框架类实验等"好玩 / 杂项"插件。

- [SenmuuuuW/dsh-group-photo](https://github.com/SenmuuuuW/dsh-group-photo) (★11) — Internal-test group-photo wall (GitHub OAuth, frozen allowlist).
- [syy-shark/dsh-music-plugin](https://github.com/syy-shark/dsh-music-plugin) — Music plugin.
- [unknowbug/RE-Framework](https://github.com/unknowbug/RE-Framework) (★5) / [unknowbug/anchorlaw](https://github.com/unknowbug/anchorlaw) (★4) — Frameworks.
- [hxs996-beep/deepAct](https://github.com/hxs996-beep/deepAct) (★7) — deepAct.
- [aga-j/dsh-mini-games](https://github.com/aga-j/dsh-mini-games) — Pure-frontend mini-game collection in the web details panel: guess-the-number, 2048, minesweeper (`dsh plugin --profile web add dsh-mini-games`).
- [weibaohui/dsh-matrix](https://github.com/weibaohui/dsh-matrix) (★0) — Matrix digital rain: drapes the chat window in the classic green character rain — cascading columns with incandescent white heads and green tails, streaming the tokens the agent is generating into the rain in real time; opacity, speed, density, font size and colors are all adjustable, and rain intensity follows agent activity.
- [weibaohui/dsh-kite](https://github.com/weibaohui/dsh-kite) (★0) — Kite-flying engine: while the agent codes, an animated kite drifts and sways in the wind on screen, tethered to the bottom edge of the window — the busier the agent, the denser the events and the higher it flies; ships a Weifang-style framework card deck (sand-swallow, goldfish, butterfly, bagua, dragon-head and more, hard-wing / soft-wing / flat / dimensional frames), with shape x pattern x colors all swappable data configs, and supports pasting user images onto the kite face with real-time affine transforms as the kite banks.
- [weibaohui/dsh-ambient](https://github.com/weibaohui/dsh-ambient) (★0) — White noise player: lays a layer of background sound (rain, streams, campfire, café…) while AI codes, helping you enter flow, stay focused and think efficiently, so you write code fast and well. Supports multiple playback modes (sequential / shuffle / single-loop / intermittent) and AI automatic background music download.





## Hands-on Notes

**中文 · 实战评测**：下面挑了 6 个有代表性的高星插件，按"怎么装 / 怎么用 / 坑点"写成可直接照着做的短评测（star 数为 2026-08-13 当晚撰写时数据）。涉及 `dsh-external/*` 私有仓库的，已标注需要读取权限。

**English · hands-on notes**: short, copy-pasteable reviews of six representative
high-star plugins — install / use / gotchas. Star counts are from the night of
2026-08-13. Entries under `dsh-external/*` are private repos and need read
access.

- [weibaohui/dsh-gaokao](https://github.com/weibaohui/dsh-gaokao) (★0) — Gaokao countdown blackboard: desktop blackboard widget counting down days to the gaokao (double-click to collapse into a slim bar), with random knowledge-card quizzes while the agent works; open Markdown knowledge-card framework, drop .md files under subject/category folders to auto-load.

- [weibaohui/dsh-fireworks](https://github.com/weibaohui/dsh-fireworks) (★0) — Fireworks celebration engine: floats fireworks above the chat window while the agent codes; welcome, per-turn, tool-spark, milestone, finish and failure events each draw from their own fireworks card group with random variants, and token usage decides firework size, height and splendour.

### dsh-web-ui — Web UI 全家桶（★311）

**装**：npm 已发布到 `@linxin666` scope，推荐直接装聚合包：
`dsh plugin --profile web add @linxin666/dsh-web-ui-all`；只要皮肤就装
`@linxin666/dsh-skins`。装完重启 `dsh web`，侧边栏即出现全部入口。

**用**：任务看板（支持 cron 定时让 DSH 会话自动执行，如每天升级 DSH / 周一生成周报）、
Git 图谱、右侧预览面板（Markdown/HTML/代码/diff/CSV/PDF/Office/图片）、鲸鱼娘宠物、
实时 TPS 与令牌统计、移动端远程控制、以及 SSH 远程运维（xterm 终端 / SFTP / 端口转发 /
集群并发执行）。

**坑**：首次安装若报 `ERR_PNPM_IGNORED_BUILDS`，按提示把 `cloudflared` / `ssh2` 等加入
profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 再重跑。验证是否挂上可用
`dsh --profile web --dump-config`。

*Install `@linxin666/dsh-web-ui-all` to get the whole bundle (task board, git
graph, right panel, pet, live token stats, mobile remote, SSH ops). Add
`@linxin666/dsh-skins` for skins only. Restart `dsh web` after install. If you
hit `ERR_PNPM_IGNORED_BUILDS`, allowlist `cloudflared`/`ssh2` in the profile's
`allowBuilds`.*

### dsh-cc-tui — Claude Code 风格全屏终端（★103）

**装**：`dsh plugin --profile cc-tui add dsh-cc-tui`（会自动初始化 `cc-tui`
profile），然后 `dsh --profile cc-tui` 启动；或仓库根目录 `sh install.sh`
（Windows 用 `dsh-cc.cmd`，支持 `--resume` 恢复上次会话）。

**用**：像素鲸鱼顶栏 + 启动手绘动画、实时工作状态行（在跑哪个工具 / 思考文案）、
思考过程流式展开、双击 Esc 时间回溯（fork 重放历史消息）、底部蓝白上下文进度条 +
TPS 仪表、复刻 CC 的 `/` 命令菜单（`/plan` `/goal` `/compact` `/review` 等全部走官方链路）。

**坑**：需要官方 `dsh` CLI 与 `pnpm`；纯插件挂载，卸载即完全还原。它**不消费审批流**
（`/permissions` 仅说明现状）；`/model` 实时切换走"会话 fork 续聊"而非原位换模型。

*A Claude-Code-style full-screen TUI: pixel-whale banner, live status row,
streaming thinking, double-Esc rewind (fork + replay), context bar + TPS meter,
and CC-style `/` commands that all ride DSH's official services. Pure Cordis
mount — removing the plugin fully restores the host. No approval-flow UI yet.*

### DSH-better-sidebar — 侧边栏完整工作台（★71）

**装**：npm 已发布 `dsh-better-sidebar@0.10.2`：
`dsh plugin --profile web add dsh-better-sidebar@0.10.2`，装完重启 DSH 并硬刷新
（Cmd/Ctrl+Shift+R）。嫌麻烦可 `curl -fsSL <repo>/scripts/install.sh | bash`，脚本会
自动处理 `allowBuilds` 与旧挂载行。

**用**：右侧栏 + 底部面板双工作台——资源管理器（懒加载目录树、`@文件` 引用）、
CodeMirror 编辑预览（Office/PDF/HTML 沙箱 iframe）、内嵌浏览器（沙箱 iframe）、
xterm 真实终端（每会话最多 3 个）、Git 面板（真 diff + 暂存/提交）、后台任务页。
暴露 `ctx.betterSidebar` 服务，其它插件可注册侧边栏 Tab 与文件预览器。

**坑**：pnpm 11 的 `strict-dep-builds` 可能拦截 `node-pty` 构建，执行
`pnpm approve-builds --all` 再重跑；Git 面板无 push/pull/fetch；
`.xlsx` 不保留单元格样式，Office 预览约 23MB 首次较慢。

*Right-sidebar + bottom-panel workbench: file explorer, CodeMirror editor with
Office/PDF/HTML preview, sandboxed in-app browser, real xterm terminal, git
panel, background-task view. Exposes `ctx.betterSidebar` so other plugins can
register tabs/viewers. On pnpm 11 run `pnpm approve-builds --all` if node-pty's
build is ignored. Git panel has no push/pull; Office preview is ~23MB on first load.*

### dsh-vision-toolkit — 让纯文本模型"看见"（★110，私有仓库）

**装**：目前是 `dsh-external` 私有 GitHub release，需对该仓库的读取权限。
`git clone https://github.com/dsh-external/dsh-vision-toolkit.git` 后
`dsh plugin --profile web add "$PWD/dsh-vision-toolkit"`（Web 和 Headless 各加一次）。
Web 端进 **Settings → Vision Toolkit**，配一个 DSH Credential（如 `VISION_API_KEY`）
并点 **Test connection**。

**用**：会话里把图片放进 workspace 路径，调用 `/vision-tools` 激活，再让 Agent 用
`vision_glance`（图像问答）、`vision_ground`/`vision_detect`（定位框）、
`vision_crop`/`vision_trace`（裁剪/转 SVG）、`vision_pixel_diff`（像素比对）、
`vision_long_screenshot_ocr`（长截图 OCR）等 10 个工具。本地裁剪 / trace / 像素差
**不需要**视觉 API；远程识别需一个 OpenAI 兼容视觉端点（managed runtime 会自动装好
Python 3.11+ 环境）。

**坑**：私有仓库，没权限 `git clone` 会失败；远程工具需要配 Credential，否则只有本地
工具可用。

*Gives text-only DSH agents eyes via 10 structured vision tools (Q&A, grounding,
OCR, pixel diff, UI restoration…). Private `dsh-external` repo — needs read
access. Local crop/trace/diff need no vision API; remote recognition needs an
OpenAI-compatible endpoint configured as a DSH Credential. Managed runtime
auto-prepares Python 3.11+.*

### oh-my-dsh — 687 个插件的能力库（23 轮差距登记，5286 测试全绿）

**定位**：从 opencode / oh-my-pi / Codex / Claude Code / pi / Goose 等对照，把有用能力
以 DSH 插件形态重写——**只走扩展接缝**（`ctx.effect()` / `ctx.on()` / `ctx.tools`），
不改 agent-loop、不引入热路径开销。已登记 23 轮差距、687 个插件。

**用**：仓库按 `plugins/<gap-id>/` 组织，每个都是独立 DSH 插件。
`pnpm install && pnpm test` 跑全部；单个插件 `cd plugins/<gap-id> && pnpm test`。
端到端验证（`e2e/run-e2e.sh`）需要 `DSH_HOME/.env` 里的 `DEEPSEEK_API_KEY`。

**坑**：这是插件"**源码库 / 能力库**"，不是一条 `dsh plugin add` 就能装全家桶的聚合包；
要按需挑选具体插件单独安装。

*A capability library: 687 plugins rewritten from opencode / Claude Code / Codex /
pi / Goose etc., all through DSH's extension seams (no agent-loop changes). 5286
tests green. It's a source/ability repo, not a one-line aggregate — pick and
install individual plugins under `plugins/<gap-id>/`. e2e needs `DEEPSEEK_API_KEY`.*

### dsh_workflow — 把多 Agent 调度升级成可治理 Workflow（★30，私有仓库）

**装**：`dsh-external` 私有仓库，
`dsh plugin --profile web add "github:dsh-external/dsh_workflow#main"`，
`dsh --profile web --dump-config` 验证配置里出现 `dsh-external-workflow` 行后重启。

**用**：会话里 `/workflow list` 看内置/项目/个人 workflow；`/workflow parallel-investigation
{"question":"…"}` 跑并行调研；`/workflow create 设计一个并行安全评审流程` 现场生成；
`/workflow review --risk high --requirement "不得破坏公开 API" --wait` 跑受控评审。
支持命名/项目/个人 workflow、run graph、暂停/恢复/重跑/续跑、成本记录，以及
capability-only VM（QuickJS WASM）安全边界。

**坑**：需 Node >=22.19 且与 `compatibility.json` 一致的 DSH 快照；`github:` 安装需对该
私有仓库读取权限；`/workflow create` 形式**不接受** `--wait`，同步等待请用命名 workflow
的 `--wait`。同类多 Agent 主题另见 `dsh-agent-teams`。

*Upgrades one-shot multi-agent dispatch into a governable Workflow layer:
named/project/personal workflows, run graph, pause/resume/rerun, cost records,
and a QuickJS-WASM capability-only sandbox. Private `dsh-external` repo —
`github:` install needs read access and Node >=22.19. `/workflow create` does not
accept `--wait`; use it on named workflows. For teams of agents, see
`dsh-agent-teams`.*

## Other awesome lists (meta)

These are community "awesome" indexes for DSH — useful cross-references, some
with daily compatibility tracking:

- [AdamPlatin123/awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins) (★187) — Directory with daily compatibility tracking.
- [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) (★84) — Curated plugins/tools/infra from `dsh-external/hub` and the `dsh-plugin` topic.
- [Alex-Yanggg/awesome-DSH-plugin](https://github.com/Alex-Yanggg/awesome-DSH-plugin) (★27)
- [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (★19)
- [bruc3van/awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin) (★8)
- [walkinglabs/awesome-deepseek-harness-plugins](https://github.com/walkinglabs/awesome-deepseek-harness-plugins) (★1)
- [satan9394/dsh-public](https://github.com/satan9394/dsh-public) (★0) — 统一精选目录：合并 awesome-deepseek-harness 与 awesome-deepseek-harness-plugins，跨源去重、剔除死链（3362 条）。A single deduplicated DSH curated list (plugins / skills / MCP / UI) merged from both awesome lists.

## Contributing

**中文**：两种方式让插件被收录，二选一即可——

**通道 A · 零维护（推荐）**：直接给你的 GitHub 仓库打上 **`dsh-plugin`** 话题。
[PLUGINS.md](PLUGINS.md) 由 [update.yml](.github/workflows/update.yml) 每天从
该话题自动抓取刷新，**无需提 PR**，约 24 小时内就会出现在快照里。

**通道 B · 进精选列表**：想进上面人工分类的精选 README？提一个 PR，把它加到合适的
分类（附一句话描述与当时的 star 数）。这个 PR 会被
[review-pr.yml](.github/workflows/review-pr.yml) **按规则自动审核**：

- ✅ 只能改 `README.md`（不能顺手改其他文件）；
- ✅ 新增的每个仓库必须公开存在；
- ✅ 必须明显是 DSH 插件——要么带 `dsh-plugin` 话题，要么名称/描述里出现
  DeepSeek Harness / DSH / Cordis / 外挂 / 插件 等字样；
- ✅ 不能与已有条目重复；
- ⚠️ `dsh plugin add <pkg>` 安装命令需格式正确。

全部通过会打 `auto-approved` 标签并**自动合并**；不通过会打 `changes-requested`
并指出原因，改完重推即可。维护者仍可随时人工覆盖。

完整规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

Found or built a plugin? Make it discoverable — pick either:

**Channel A · Zero maintenance (recommended):** just add the **`dsh-plugin`**
topic to your GitHub repo. [PLUGINS.md](PLUGINS.md) is fetched daily from that
topic by [update.yml](.github/workflows/update.yml) — no PR needed; it appears in
the snapshot within ~24h.

**Channel B · Curated list:** want it in the categorized README above? Open a PR
adding it to the right section (one-line description + star snapshot). The PR is
**auto-reviewed by rules** via [review-pr.yml](.github/workflows/review-pr.yml):

- ✅ Only `README.md` may be changed.
- ✅ Every added repo must exist and be public.
- ✅ Must be clearly DSH-related: carry the `dsh-plugin` topic, or mention
  DeepSeek Harness / DSH / Cordis / 外挂 / 插件 in name or description.
- ✅ No duplicates of existing entries.
- ⚠️ `dsh plugin add <pkg>` install commands must be well formed.

All checks pass → auto-labeled `auto-approved` and **auto-merged**. Otherwise
`changes-requested` with reasons; push a fix to re-run. A maintainer can still
override at any time.

Full rules: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

The list content is released under [CC0 1.0](LICENSE). Individual plugins keep
their own licenses (mostly MIT, some CC BY-NC-SA for skins).
