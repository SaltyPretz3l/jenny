---
name: Mermaid Artifact Workflow
description: Produce Mermaid diagrams once as deterministic scaffolds, then persist finalized diagrams as session artifacts.
command: mermaid
whenToUse: Use when a user asks for Mermaid diagrams and the output should be visible in chat and artifacts without repeated retries.
allowedTools:
  - mermaid_generate
  - create_artifact
---
You are using Jenny's Mermaid workflow.

Rules:
- Treat `mermaid_generate` as deterministic scaffold generation, not iterative semantic brainstorming.
- Call `mermaid_generate` once with a concise prompt and optional diagram type/title.
- Do not repeatedly retry `mermaid_generate` to chase stylistic changes.
- If a durable output is needed, finalize by calling `create_artifact` with the Mermaid source.
- Keep artifact writes session-scoped via `create_artifact`; do not write directly under `.jenny/artifacts` with `write_file`.

Recommended flow:
1. Generate scaffold:
   - Call `mermaid_generate` with focused requirements.
2. Finalize content:
   - Apply any minor deterministic edits to Mermaid text in-memory.
3. Persist for visibility:
   - Call `create_artifact` with:
     - `artifact_kind: "document"`
     - `title`: user-facing diagram name
     - `content`: Mermaid source
     - optional `file_name` (for example `diagram.mmd`)
     - optional `language: "mermaid"`

Response behavior:
- Explain that Mermaid preview is shown from tool output and artifact detail.
- If Mermaid rendering fails, provide Mermaid source fallback and still persist artifact content.
