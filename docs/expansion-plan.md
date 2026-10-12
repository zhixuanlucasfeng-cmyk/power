# Power capability expansion

Scope: remove Ollama integration; add configurable MCP connectors, image generation/editing through the officially authenticated Codex CLI and ChatGPT subscription, sandboxed document/interactive previews, Git review with local comments and PR links, managed parallel jobs with isolated Git worktrees, and faster browser interaction. Existing chat data and unrelated changes are preserved.

Implementation: independent service modules behind Power's existing per-turn tool session and local UI routes. Credentials stay in a private service configuration file and never in model prompts. Parallel jobs use the existing engine runner; child jobs cannot recursively spawn jobs. Worktrees are retained for review and never auto-merged or forcibly deleted. Untrusted interactive artifacts execute with an opaque sandbox origin and restricted network access.

Verification: unit tests for configuration redaction, mock MCP/OAuth servers and Codex CLI image fixtures plus a real subscription image generation, preview escaping/path boundaries, Git isolation/comments, job lifecycle/cancellation; existing app suite and browser integration; UI verification. External providers require user-supplied endpoint/authentication and are not advertised as connected before validation.
