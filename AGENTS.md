# Agent instructions

These rules apply to every AI coding agent working in this repository (Claude
Code, Codex, Cursor, Copilot and others). This repository is public, so
anything committed is published.

## Where your reports and documents go

| What | Where |
| --- | --- |
| Reports, audits, plans, reviews, release records, working notes | `.internal/agents/<agent>/YYYY-MM-DD-<topic>.md` |
| Machine-readable evidence for a report (JSON, diagnostics) | Next to the report, in `.internal/agents/<agent>/` |
| Generated artefacts: screenshots, logs, builds, browser output | `outputs/<topic>/` |
| Throwaway scripts and scratch files | `.internal/agents/<agent>/scratch/` or the system temp directory |

`<agent>` is your tool's short name in lowercase, such as `claude` or `codex`.
Both directories are ignored by Git and excluded by `npm run check:public`.

Do not write agent reports anywhere else:

- `docs/` holds maintained, public user and contributor documentation only.
  Do not add audits, plans or dated reports there.
- `scripts/` and `test/` hold code the project ships or runs in CI. Put
  one-off diagnostic scripts in your scratch directory.
- Do not hide files with `.git/info/exclude`. Other agents cannot see those
  rules, and a single `git add` of the path still publishes the file.

## Shared working tree

Several agents may work in this checkout at the same time.

- Stage files by explicit path. Never run `git add -A` or `git add .`, which
  can commit another agent's unreviewed files.
- Do not edit, move or delete files another agent is working on. Mention them
  in your report instead.
- Before committing, run `npm run check:public` and review
  `git diff --cached --name-only`.

## Temporary files

Keep temporary files on the internal disk, for example
`TMPDIR=/private/tmp/unprompted-tmp`. SQLite commits on the external
`/Volumes/WorkDisk` image take about one second each, which makes the test
suite run for an hour instead of about 90 seconds.
