# Domain docs

This project uses the single-context layout: root `GLOSSARY.md` and `docs/adr/`.

## Before exploring

Read `GLOSSARY.md` and ADRs relevant to the work. If these files do not yet exist, continue; `domain-modeling` creates them lazily as terminology and decisions are resolved.

If the project later adopts `GLOSSARY-MAP.md`, read its relevant per-context glossaries and context-scoped ADRs as well as system-wide decisions.

## Vocabulary and decisions

Use the glossary's terms when naming concepts in issues, code, tests and explanations. Reconsider invented terminology; note genuine gaps for `domain-modeling`.

Surface contradictions with an existing ADR explicitly, naming the decision and why it should be reconsidered.

## Layout

- `GLOSSARY.md`: shared domain vocabulary.
- `docs/adr/0001-<decision>.md`: numbered architectural decisions.
- `AGENTS.md`: project instructions, separate from domain documentation.
