# Issue tracker: Local Markdown

Issues and specs live in `.scratch/` in this project. These are project records, not disposable cache: keep them versionable and include their Markdown in formatting checks. Git commits remain subject to the user's approval.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`.
- Spec: `.scratch/<feature-slug>/spec.md`.
- Tickets: one file each at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`.
- Record triage state as a `Status:` line near the top, using [the configured labels](triage-labels.md).
- Record dependencies as `Blocked by: NN, NN`; a ticket is ready when its blockers are complete.
- Append conversation history under `## Comments`.

## Tracker operations

- Publish: create the corresponding local Markdown file and directories.
- Fetch: read the path supplied by the user; ask when a ticket number is ambiguous.
- Complete: record the outcome and verification results in the ticket, preserving its history.

## Wayfinding operations

For a future wayfinding workflow, the map is `.scratch/<effort>/map.md` with Notes, Decisions-so-far and Fog sections. Child tickets use `issues/NN-<slug>.md`, a `Type:` of `research`, `prototype`, `grilling` or `task`, and a `Status:` of `claimed` or `resolved`.

Choose open, unblocked, unclaimed tickets by number. Save `Status: claimed` before working. Resolve by appending `## Answer`, setting `Status: resolved`, and linking the answer from the map's Decisions-so-far section. These map states are separate from the issue-triage labels.
