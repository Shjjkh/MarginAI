# Project Context

## Product Direction

MarginAI is an open-source Obsidian plugin for AI-assisted reading. It is not a traditional "chat with document" product.

Core interaction:

- The user reads a Markdown manuscript/document in Obsidian.
- The user selects source text and asks a question about that selection.
- The answer appears as an annotation tied to the selected source text, not as a separate chat transcript.
- Annotation cards should help the user internalize reading notes and optionally turn them into durable Markdown notes.

The product owner leads product design, interaction design, and feature definition.

## Collaboration Role

Codex should act as an engineering-focused technical partner.

Expected responsibilities:

- Translate product ideas into implementable technical plans.
- Suggest reasonable frontend and backend architecture.
- Identify implementation risks, hidden complexity, and tradeoffs.
- Ask clarifying questions when product intent or technical constraints are unclear.
- Implement code only after the product owner gives an explicit implementation request.

Boundaries:

- Do not make product decisions proactively.
- Do not expand feature scope or redirect the product without confirmation.
- Do not generate large amounts of code before an explicit implementation instruction.

## Confirmed Product Constraints

- Product/plugin name: `MarginAI`; Obsidian plugin id: `margin-ai`.
- The project is intended to be open source.
- The plugin targets Obsidian desktop first.
- The first supported document format is Markdown.
- The Obsidian vault is the manuscript library.
- The plugin should work with Markdown notes/files already managed by Obsidian.
- The sidebar is file-scoped: it manages annotations for the currently open Markdown file, not a global all-vault annotation center by default.
- Creating an annotation should not automatically create a Markdown file. Users can explicitly generate a Markdown note from an annotation card.
- Annotation data should remain user-owned and vault-local.
- Local image rendering is out of scope for v1; Markdown image references are skipped.

## Core Interaction Decisions

- Selecting text and running the ask command should open/focus the MarginAI sidebar and show the question input there rather than using a modal.
- `Enter` submits/saves; `Shift+Enter` inserts a newline.
- Users can create AI annotations from `对选中文本提问` and personal annotations from `增加批注`.
- AI responses appear with the user's question in annotation cards.
- Annotation card bodies are editable.
- Users can continue asking follow-up questions on an annotation, with the AI using prior context.
- Source text that has an annotation should be highlighted distinctly from Markdown underline/emphasis styling.
- Clicking an annotation or its highlighted source text should activate the annotation and scroll to the corresponding source location.
- If a generated annotation note is deleted from the vault, the annotation card should forget the stale note path and show `保存为笔记` again.

## Technical Decisions

- Runtime: Obsidian plugin.
- Project location: `plugin/`.
- Language/build: TypeScript + esbuild targeting the Obsidian plugin API.
- UI approach: Obsidian-native DOM/components rather than React for the current plugin.
- Use Obsidian APIs for file access, workspace views, editor integrations, settings, and persistence.
- Prefer a local-first architecture and simple setup for open-source users.
- AI integration: OpenAI-compatible REST API only; BYOK. Users configure API key, endpoint, and model in settings.
- Supported AI provider direction: OpenAI-compatible providers, including OpenAI, Anthropic through a compatibility layer, and local Ollama.
- Web search is optional and user-configured, not a built-in hosted service. Default search provider direction is Tavily Search API, with a custom URL-template provider for advanced users.

Superseded directions:

- Standalone Electron reader direction is superseded by the Obsidian plugin direction.
- SQLite annotation storage is superseded by Obsidian/vault-local plugin storage and Markdown-backed generated notes.

## Annotation Storage And Notes

- Active annotation cards and lookup metadata are stored in Obsidian plugin data.
- User-triggered generated annotation notes are Markdown files, defaulting to `MarginAI/Annotations` in the prototype.
- The durable anchor model is hybrid: paragraph block ID + quoted source text + intra-block character offset, with fuzzy matching on render and a degraded "unconfirmed" state if the anchor is lost.
- Generating an annotation note should create bidirectional links: the generated note links back to the selected source block, and the source note selection links to the generated annotation note.
- For single-line selections, wrap the selected text as a wiki link. For multi-line selections, append a compact `批注笔记` wiki link after the selection to avoid disrupting Markdown structure.
- Generated note titles should summarize the selected subject and user question, not copy the raw question.
- If an annotation has a generated note, saving the card should rewrite the generated note while preserving its wrapper format.
- Generated note sync compatibility: notes keep the H1 and opening blockquote as metadata/wrapper; the editable answer body is everything after the opening quote block. When syncing note content back to cards, H2-H6 headings become bold standalone card headings. When syncing cards to notes, bold standalone headings become H2 headings.

Generated annotation note format:

- Markdown, readable, and mechanically generated.
- A content-derived title as file name and H1.
- An opening blockquote containing the linked selected source quote and the user's question.
- The answer body follows the quote block.
- Avoid tables, code fences, HTML/XML, JSON, and heavy structure.

## AI Answer Behavior

- AI annotation answers should be simple Markdown bodies that can be saved directly: no JSON/XML/HTML/code fences/tables, no preamble, same language as the user question, short paragraphs or flat bullet lists only.
- Except for translation or very short answers, model output should use independent bold section-title lines such as `**定义**`, followed by the section body. Generated notes mechanically convert those bold section-title lines to H2 headings.
- AI requests use an intent classifier with intent-specific prompt strategy, information boundary, context inclusion, and length constraints.
- Current intents: concept explanation, confusion about source text, deeper discussion, summary, translation, writing/rephrasing help, structure-preserving inference, and follow-up handling via reclassification of the latest follow-up question.
- Concept, confusion, discussion, and inference answers should usually be detailed enough to build understanding. Summary, translation, and writing/rephrasing tasks should stay concise and task-bounded unless the user asks for depth.
- Inference answers should minimize restating the selected text, preserve useful source structure, add concrete inference value, and distinguish direct source support, reasonable inference, and uncertain speculation.
- Answer quality is improved through external JSON answer skills. Built-in open-source skills live under `plugin/skills/*.json`; users can configure a vault folder such as `MarginAI/Skills` for custom JSON skills. Custom skills with the same `intent` override built-ins.
- Internal process scaffolds in answer skills are for weak-model stability and must not be shown in saved annotation answers.
- Web search results are supplemental material, not source text. Answers should clearly distinguish what the original article says from what external results add, especially for newer concepts.

## UI Direction

- The reading experience has two main areas: reading area and annotation area/sidebar.
- Markdown should be rendered as readable formatted content, not raw Markdown syntax.
- Annotation cards should be visually associated with their selected source text.
- Cards use subtle hover/active emphasis, compact Obsidian-native styling, modest radii, light borders/shadows, and readable text hierarchy.
- Annotation cards are collapsed by default with a uniform fixed height, currently `360px`, so users can see several lines of the answer without expanding. Card expand/collapse is independent from quote expand/collapse: expanding a card sets height to `auto` and reveals full question, quote, and answer; collapsing returns to the uniform fixed height. Collapsed overflowing cards use a bottom fade plus a low-emphasis horizontal text button (`展开全文` / `收起`) with subtle gray border/background. Quote expand/collapse remains a separate icon-only control inside the quote area.
- The annotation list is the scroll container. Cards and input panels must not shrink as flex children; expanding one card should increase list scroll height rather than compressing neighboring collapsed cards.
- The sidebar annotation list should follow the source text order in the current file, using each annotation's source anchor offset rather than creation time.
- User questions should have a subtle tinted background.
- Cards may be color-coded by rough question intent, but explicit intent labels should not be exposed to users.
- Pending AI/personal annotation cards and existing-card edit mode should share the same compact editor-panel interaction.
- Pending AI question panels should not show decorative header icons; the header title should mirror the user's typed question once available, falling back to `新提问` only while empty.
- AI submission should show an explicit loading state with spinner/status/skeleton rather than leaving the form apparently editable or frozen.

## Important Open Questions

These are not yet decided:

- Whether the plugin should enhance Obsidian's standard Reading View, Live Preview editor, or provide a custom reader view for annotated reading.
- Exact long-term vault folder conventions for generated annotation notes and custom answer skills.

## Requirements Source Notes

The initial requirements were provided in `/Users/feijizhadan/Desktop/AI阅读器需求文档.pdf` on 2026-04-29. Key product requirements from that document have been merged into this context file.
