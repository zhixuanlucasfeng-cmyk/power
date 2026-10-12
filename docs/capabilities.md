# Power capability audit and browser tools

Updated 2026-10-12. User data: `~/.power`; source code lives in your cloned repository.

This compares the practical tools available in the Codex desktop conversation with Power's local CLI adapters. It does not claim feature parity with every Codex service.

| Capability | Power implementation |
| --- | --- |
| Read/edit files, run commands, Git | Already provided by agent CLIs that support these tools. The conversation's working folder defines the project. |
| Memory and reusable skills | Existing Power MCP and Markdown storage. |
| Attachments, chat history, groups, background service | Existing Power features. |
| Web search / extraction | Existing optional Contract gateway; interactive websites can now be browsed directly with the browser tool. |
| Visible browser, DOM snapshots, forms, tabs/popups, uploads/downloads, screenshots, PDF | Added persistent Playwright MCP browser managed by the Power service. |
| Human login handoff / questions | Added `request_user_input`: cards, options/free text, cancellation and resume. Human waiting time is excluded from the turn execution limit. |
| Task checklist | Added `update_plan`, displayed and retained in chat. |
| Generated files | Added `show_artifact`: image preview or file download, retained in chat. Interactive HTML executes in an opaque sandbox with networking disabled, never in Power's origin. |
| Agent-managed recurring tasks | Added `manage_schedule` on top of the existing scheduler. Daily schedules use the host Mac's timezone (returned by list). |
| Send/post confirmation | Existing confirmation card now also works through the CLI bridge and pauses the execution timer. It remains an agent instruction, not a semantic firewall around arbitrary website buttons. |
| Tool activity/errors | Codex MCP calls now show start, actual output and failure state. |
| Stop | Revokes turn tool access, cancels pending human questions/confirmations and terminates the agent's process group. Already-issued browser actions may finish; queued actions are rejected. |
| Desktop automation | Existing optional Cua Driver integration; requires installation and macOS permissions. |
| Image generation/editing | Built-in Codex CLI image generation using the local ChatGPT login and subscription allowance; no API-key fallback. |
| Account connectors | Configurable stdio/HTTP MCP, bearer tokens or standard OAuth with PKCE/dynamic registration. Each service requires its own connection and authorization. |
| File workspace | PDF, images and media playback; DOCX/XLSX/PPTX content previews; sandboxed interactive HTML; save edited text as a new copy. |
| Code review | Git diffs including untracked text, local versioned comments and PR link attachment. No automatic publication or merge. |
| Parallel agents | Managed jobs using installed agent CLIs, cancellation, persisted status and optional isolated worktrees. |
| Audio/video generation, cloud execution and provider-specific Office editing | Not implemented by these local workspace additions. |
| Cloud execution, account billing, Codex app internals | Not portable local tools. |

## How to use

In a Power Codex or Claude chat, ask:

- “打开 Dubizzle，让我在浏览器里登录，登录后继续帮我找房。”
- “准备一篇 Reddit 帖子，填写到编辑器里，发布前让我确认。”
- “把任务拆成步骤，做好报告后把文件展示在这里。”
- “每天早上 8 点检查这个项目，发现需要处理的变化时告诉我。”

The browser opens on this Mac. Credentials and verification codes are entered directly on the website. Click **已完成，继续** in Power after completing login; the agent must inspect the page again. Cancellation or a 15-minute unanswered handoff never counts as a completed login. Website-specific access checks or automation blocks may still prevent a task; the browser does not bypass them.

In managed browser mode, cookies and website storage stay in `~/.power/browser-profile` (directory mode 0700); the user's normal browser profile is not copied. Tabs survive agent turns while Power runs. A service restart closes tabs cleanly and preserves the profile. One running turn holds the browser at a time; another chat receives a busy response. The Settings **打开浏览器** button can bring it forward.

Google Chrome is used when installed at `/Applications/Google Chrome.app`; otherwise install the managed Chromium browser with `npm run browser:install`. Dependencies are pinned in package-lock.json. Backend dependency: [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp).

## Engine support and tool protocol

- **Codex / Claude Code:** native Power MCP tools. Codex receives a 1200-second MCP timeout so human handoff can complete. Claude receives `MCP_TOOL_TIMEOUT=1200000`.
- **Other agents with a shell tool:** the system prompt supplies `node /absolute/path/to/tools-cli.mjs list`, followed by `TOOL_NAME 'JSON_ARGUMENTS'`. Actual use depends on that CLI's shell support and model tool-use ability.
- **Ollama:** local-model discovery and adapter removed; existing chat history is preserved.

`browser` accepts `action="tools"` to list the pinned backend's exact names and parameter schemas; then call `browser(action=<name>, args={...})`. Use `browser_snapshot` to inspect the current page. `show` brings the current page forward. Arbitrary host-code execution (`browser_run_code_unsafe`) is excluded from the exposed catalog. The internal focus operation uses a fixed, app-owned snippet.

The service hosts the browser independently of MCP child processes. New agent turns receive ephemeral bearer tokens via the environment; no credential is placed in command arguments. The `/api/agent-tools` endpoint validates these tokens and pins actions to that turn's character and working folder. User-facing mutation routes reject foreign browser origins. Generated artifacts must resolve to regular files in the working folder, uploads, or browser-output directory, including after resolving symlinks.

## Validation

`npm test` covers the MCP bridge against a real scratch Power server, user handoff beyond the execution limit, cancellation/token revocation, artifact delivery/path restrictions, schedule validation, parsing and existing chat functionality.

`npm run test:browser` runs a local synthetic site in a real browser and exercises form filling, popups, snapshots, screenshots, cross-turn continuation and persistent website storage. `POWER_TEST_HEADED=1 npm run test:browser` runs the same scenario with a visible window. It never uses a real account or publishes a real post.

To load changes into a running installation, run `power service restart` (waits for active chats). Reload the Power window with Cmd+R. For the native desktop shell, build with `npm run desktop:build` after installing dependencies. The generated app references your local checkout; keep that checkout in place.

## 网页兼容模式的右侧浏览器面板

聊天顶部的「🌐 浏览器」打开同一 Chrome 会话的实时画面（约每 300 毫秒轮询一次，实际帧率取决于截图速度），支持地址栏、标签页、后退和刷新。点击网页或滚动会自动接管，可以输入中文或粘贴；完成登录后点击「交还控制」，再回答登录卡片。手动接管期间 agent 浏览器操作被阻止。独立浏览器首次按面板尺寸设置视口，此后保持尺寸以避免多个窗口导致点击错位。

这是一种可交互的实时浏览器画面，并非嵌入 Chromium 内核：视频、原生菜单、密码管理器、文件选择器等复杂交互请使用「独立窗口」。截图仅通过本机接口传输，不存入聊天。关闭面板会交还控制；关闭整个 Power 窗口后如果仍在手动接管，下次打开可以交还。

检测到 Access denied / Error 15 时显示网站拦截提示，不自动重试或绕过限制。面板和独立窗口共用浏览器资料目录；它们不会自动拥有日常 Chrome 的登录状态。

## Workspace limits and subscription images

Office previews show document paragraphs, spreadsheet values and slide text; they do not reproduce full Office layout or provide native Office editing. Interactive previews block outbound network access. Connector accounts are configured in Power and are not inherited from Codex desktop. Local review comments and PR attachments do not post to GitHub. Isolated worktrees begin from committed HEAD and exclude uncommitted changes; Power refuses to remove dirty worktrees or worktrees containing new commits.

Images use the official Codex CLI built-in tool with `forced_login_method="chatgpt"` and API credentials excluded from the subprocess. The local CLI must show `Logged in using ChatGPT`; this does not separately verify that its account matches the desktop account. Usage counts against Codex subscription limits: [official image generation documentation](https://learn.chatgpt.com/docs/image-generation). A real subscription image was generated during validation; cancellation and missing-output failures are also covered by adapter tests.

## Existing Chrome tabs

Choose **我的 Chrome · 已有登录** in the browser panel. Install the [official Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) in the Chrome profile containing your signed-in tabs, then click **连接** and approve/select a tab in Chrome. Power uses the extension's scoped tab group and does not copy your cookies or profile. The connection choice persists in `~/.power/browser-connection.json`. **断开** detaches Power; it does not close your ordinary Chrome tabs. Extension installation and tab approval must be completed in Chrome before this mode can be verified on your account.

Clicking, scrolling, navigating or typing in the panel automatically takes manual control. Use **交还控制** when ready for the agent to resume. The browser viewport stays stable across multiple Power windows, and screenshots/input share a queue to keep click coordinates consistent. Chrome extension mode preserves the existing tab's viewport; native dialogs remain in the Chrome window.

## Native desktop browser (default in the new Power.app)

Power.app now uses Electron WebContentsView to embed a real Chromium page beside chat. Mouse input, selection, scrolling, keyboard/IME and file selection are handled by Chromium directly, rather than forwarding clicks through a screenshot. Native tabs and agent tools use the same page. Use **+** beside the tab strip to open a new tab; the address field receives focus. Website sessions persist in `~/.power/desktop`; they remain separate from everyday Chrome. The browser is available while Power.app is running.

The app shell and website tabs have separate persistent sessions. Website renderers have Node integration disabled, sandboxing/context isolation enabled and no Power control API. The agent adapter filters Chromium targets to the browser views, excluding the chat renderer. Native user input hands control back to the user; agent-generated input does not trigger a false takeover.

Build with `npm run desktop:build`, launch with `./power app`. The previous app is retained as a timestamped backup in `~/Applications`. The older web-only interface retains the screenshot/extension fallback; the native browser is in Power.app. `npm run test:desktop` tests real Electron tabs, agent navigation/form input, tab creation/selection, target isolation and non-destructive disconnect.
