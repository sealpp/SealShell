# Repository Memory

- `me_SealShell/` is a private, independently versioned repository.
- Keep its documentation, designs, diagrams, and related project files inside that directory.
- Use concise English Conventional Commits in the form `type(scope): summary`.
- Commit and push them separately from their respective repository roots.
- v0 is a Windows 10/11 desktop application using Tauri 2, Vue, and a Rust runtime. Tabs and layout are not persisted. Rust owns SSH/SFTP, native files, transfers, forwarding, SQLite product data, and Windows DPAPI credentials. There is no separate Node gateway, pairing, Protobuf transport, or WASM SSH runtime. Python is only a development test-fixture dependency.

## Design sync

- UI/UX design decisions and the design tracker live in `me_SealShell/`. Changes affecting design, behavior, interfaces, or usage must update the related documentation there; keep project documentation there rather than duplicating it in this repository.
- The tracker records intent, interaction conventions, and "not-in-code" boundaries; it does not duplicate implementation details retrievable from source.
- Public commits may reference private tracker IDs (e.g., `Refs: A02`) but must not include private design details.
- See `me_SealShell/AGENTS.md` and `me_SealShell/docs/v0-components.md` for the full sync convention.

## Development workflow

- For complex tasks, maintain a task tracker with decomposed subtasks and checkpoints; avoid overlong intermediate subtasks that cause context drift, loss of direction, or forgotten work.
- Split complex changes into logically scoped commits, making each as independently verifiable as practical.
- Complex tasks must use atomic commits organized by one user-visible behavior or one architecture layer. Each commit should be independently buildable, testable, and revertible where practical; do not mix design, state/model, UI, interaction, and test changes without a direct dependency.
- Before committing, inspect the staged diff and keep unrelated changes out of the commit. Push each repository from its own root after its commits are verified.
- Prefer removing confirmed-redundant or obsolete code, tests, and content over blindly appending; avoid unnecessary defensive programming and redundant logic that cause bloat and decay.

## E2E & local dev

End-to-end testing guidance for SealShell is maintained as a project skill: `.agents/skills/seal-e2e/SKILL.md`.

Do not duplicate the detailed caveats here; update the skill directly. This section exists only to disclose the skill location.

### Dev server cleanup

After testing, stop the Vite, Tauri/WebView2, and mock-server processes started by this task unless the user explicitly asks to keep them running. Do not stop unrelated services on occupied ports. Desktop E2E uses its own ports and temporary data directories.

## Engineering Docs Index

长期有效的工程经验集中维护在私有目录 `me_SealShell/docs/engineering/`：

- `pitfalls.md`：实现踩坑、根因和修复规则。
- `debugging.md`：问题排查纪律——先复现、逐层收敛定位根因、修复针对根因、禁止创可贴式补丁与冗余防御分支。
- `ai-quality.md`：AI 使用需求、Golden Dataset、可观测性与逐案例回归的维护约定。涉及 AI 行为、提示词、上下文、模型或相关重构时，先按该文档维护场景与验证记录。

排查问题时先遵循 debugging 文档；修复可复用问题后先合并、删减或改写 pitfalls 文档，再提交代码；不要在本文件复制正文或追加一次性 workaround。
