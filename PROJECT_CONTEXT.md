# Project Context

## Product Direction

MarginAI is an open-source reader product focused on "AI-assisted reading" rather than a traditional "chat with document" experience.

Core interaction:

- The user reads a manuscript/document inside Obsidian.
- The user selects a span of text.
- The user asks AI a question about that selected text.
- The AI answer appears as an annotation beside the source text, not as a chat message.
- The annotation is bound to the selected source text.

The product owner will lead product design, interaction design, and feature definition.

## Collaboration Role

Codex should act as an engineering-focused technical partner.

Expected responsibilities:

- Translate product ideas into implementable technical plans.
- Suggest reasonable frontend and backend architecture.
- Identify implementation risks, hidden complexity, and tradeoffs.
- Implement code only after the product owner gives an explicit implementation request.

Boundaries:

- Do not make product decisions proactively.
- Do not expand the feature scope or redirect the product.
- Ask clarifying questions when needed.
- Do not generate large amounts of code before an explicit implementation instruction.

## Current Technical Constraints

Confirmed constraints:

- The project is intended to be published on Git as an open-source project.
- The product and Obsidian plugin name is `MarginAI`; the Obsidian plugin id is `margin-ai`.
- The final product should be rebuilt as an Obsidian plugin rather than a standalone Electron reader.
- Annotation content should be stored directly in the Obsidian vault/plugin data model rather than treated primarily as an export artifact.
- The first document format to prioritize is Markdown.
- The Obsidian vault becomes the manuscript library location.
- The plugin should work with Markdown notes/files already managed by Obsidian.
- The reading view should have two main areas: a reading area and an annotation area.
- Markdown should be rendered as readable formatted content, not shown as raw Markdown syntax.
- Selecting text should reveal a small floating input panel where the user can ask AI about the selection.
- In the Obsidian plugin implementation, selecting text and running the ask command should open/focus the MarginAI sidebar and show the question input there rather than using a modal. `Enter` submits the question; `Shift+Enter` inserts a newline.
- AI responses should appear in the annotation area together with the user's question.
- Annotation cards should use subtle hover-only border emphasis. User questions should be displayed with a translucent tinted background, and cards should be color-coded by rough question intent without exposing explicit intent labels to users.
- Users should be able to edit AI-generated answers.
- Users should be able to continue asking follow-up questions on an annotation, with the AI using prior context.
- Annotation cards should be visually positioned beside their selected source text, scrolling with the reading area rather than behaving as an independent static list.
- Source text that has an annotation should be visibly highlighted in a way that is distinct from Markdown underline/emphasis styling.
- Clicking an annotation or its highlighted source text should activate the annotation and scroll the reader to the corresponding source location.
- Annotation data should remain visible and user-owned inside the Obsidian vault, not only hidden inside opaque plugin state.
- The plugin sidebar should manage annotations for the currently open Markdown file, not act as a global all-vault annotation center by default.
- The visible annotation sidecar file is the canonical maintained annotation document. The plugin should not create a second generated note for the same annotation by default.

Likely engineering implications:

- Prefer a local-first architecture.
- Use Obsidian's plugin APIs for file access, workspace views, editor integrations, settings, and persistence.
- Keep local setup simple for open-source users.
- AI provider configuration should likely be user-owned and configurable.
- Annotation data needs a durable vault-local format that can survive note edits and remain readable/exportable as Markdown.
- A likely storage pattern is visible Markdown sidecar files for user-facing annotation content plus a lightweight plugin index for anchor metadata, UI state, and fast lookup.
- Text anchoring needs to survive basic document changes better than a raw character offset alone.
- The AI request layer needs a context builder that combines selected text, necessary surrounding context, the user's question, and possibly prior annotation conversation state.
- The AI request layer may need routing logic that decides whether to answer from selected text, search the current full document, use model knowledge, or use web search when available.

## Confirmed Technical Decisions

- Runtime: Obsidian plugin
- Language/build: TypeScript targeting the Obsidian plugin API
- Host app: Obsidian desktop first
- Plugin project lives under `plugin/`.
- Current plugin v1 uses Obsidian-native DOM/components rather than React.
- Build tooling: TypeScript + esbuild, with `obsidian` as the API type package.
- Previous standalone Electron app direction is superseded by the Obsidian plugin direction.
- Previous SQLite annotation storage direction is superseded; annotation persistence should use Obsidian/vault-local plugin storage or Markdown-backed files.
- AI integration: OpenAI-compatible REST API only; BYOK (Bring Your Own Key) — user configures API key and endpoint in settings; no built-in hosted AI service
- Supported AI providers: OpenAI, Anthropic (via compatibility layer), local Ollama — any OpenAI-compatible endpoint
- Text anchor model: hybrid — paragraph block ID + quoted source text + intra-block character offset; fuzzy match on render, degraded "unconfirmed" state if lost
- Obsidian storage/export model: to be redesigned for plugin-native storage; prior "generate one .md file per document's annotations" export model is no longer the primary product model.
- User-visible annotation storage should be prioritized. A hybrid model is favored: Markdown files for readable annotation/comment bodies, plus plugin-managed metadata for source anchors and relationships.
- Annotation sidecar files should be Markdown, but use a constrained plain format: no headings/titles, no tables, no heavy structure. Prefer simple source quotes, question/answer text, flat bullet lists, and Obsidian links.
- Default vault folder in the plugin prototype: `MarginAI/Annotations` for sidecar annotation files.
- The initial plugin implementation saves annotation bodies to visible sidecar Markdown files and stores the fast lookup/index metadata in Obsidian plugin data.
- The sidebar view is file-scoped: switching the active Markdown file should refresh the sidebar to that file's annotations.
- The MarginAI sidebar should open automatically when the plugin loads after the Obsidian workspace layout is ready.
- AI annotation answers should be simple Markdown bodies that can be saved directly: no JSON/XML/HTML/code fences/tables, no preamble, same language as the user question, short paragraphs or flat bullet lists only. The app normalizes common weak-model output drift before saving answers.
- AI requests should first be routed through a rough intent classifier, then use intent-specific prompt strategy, information boundary, context inclusion, and length constraints. Current intents: concept explanation, confusion about source text, deeper discussion, summary, translation, writing/rephrasing help, and follow-up handling via reclassification of the latest follow-up question.
- In v1, web search is explicitly unavailable. Concept explanation may use model knowledge, but source-text questions, summaries, translations, and writing help must respect the selected text and distinguish any background supplement from what the source actually says.

## Important Open Questions

These are not yet decided:

- Whether annotations should be stored in plugin data JSON, sidecar Markdown files, embedded block markers/comments in source notes, or a hybrid.
- Whether the plugin should enhance Obsidian's standard Reading View, Live Preview editor, or provide a custom reader view for annotated reading.
- How much of the existing React UI should be reused versus rebuilt with Obsidian-native DOM/components.
- Exact vault folder conventions for annotation sidecars.

## v1 Explicit Out-of-Scope

- Web search: not supported in v1.
- Local image rendering: Markdown image references are skipped in v1; images will not be displayed.

## Requirements Source Notes

The initial requirements were provided in `/Users/feijizhadan/Desktop/AI阅读器需求文档.pdf` on 2026-04-29. Key product requirements from that document have been merged into this context file.
