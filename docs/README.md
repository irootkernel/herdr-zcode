# herdr-zcode documentation

This index maps the contributor and operational documentation for `herdr-zcode` and defines the repository's source-of-truth rules, roadmap identity namespace, and temporary execution dossier lifecycle.

## Canonical documents

| Document | Responsibility |
| --- | --- |
| [README](../README.md) | End-user installation, everyday commands, model/reasoning selection, and troubleshooting. |
| [Herdr operating guide](../HERDR.md) | Operating rules for coordinator, executor, and evaluator workflows inside Herdr. |
| [Global setup](../GLOBAL-SETUP.md) | Sharing Herdr operating guidance across repositories. |
| [Development and architecture](app-server.md) | Module responsibilities, ZCode app-server wire protocol, lifecycle invariants, and offline/live test suites. |
| [Toolchain management](toolchains.md) | `toolchains.env` declarations, `./dev` workflow, and explicit runtime upgrades. |
| [Roadmap](roadmap/README.md) | Canonical owner of Epic and Task IDs, execution order, dependencies, status, and Epic acceptance criteria. |
| [Active TODO dossiers](todo/README.md) | Index of temporary execution source-of-truth (SOT) dossiers for adopted Epics. |
| [Mulgae integration gap analysis (Korean)](mulgae-herdr-zcode-gap-analysis.md) | Original Korean diagnostic analysis comparing `herdr-zcode`, `mulgae`, `herdr-core 0.1.20`, and `ZCode.app 3.18.2`. |

## Source-of-truth precedence

Current source code and automated tests are authoritative for implemented runtime behavior. Canonical contributor documentation (`README.md`, `HERDR.md`, `docs/app-server.md`, `docs/toolchains.md`) documents supported behavior, structure, and verification workflows. The [roadmap](roadmap/README.md) alone owns delivery identity and status; neither TODO dossiers nor analysis reports create a second status authority.

When implemented behavior changes, update every affected test, package manifest (`package.json`), and canonical document in the same change instead of letting documentation drift.

## Roadmap identity

The canonical roadmap path (`docs/roadmap/README.md`) is the identity namespace for this repository:

- Epic IDs match `EPIC-[0-9]{3,}` and Task IDs match `TASK-[0-9]{3,}`.
- Epic and Task sequences are independent, monotonic, and never restarted or reused.
- Qualify cross-repository references as `herdr-zcode:EPIC-001` or `herdr-zcode:TASK-001`.
- Epic status is independent of child Task status: completing every member Task does not mark an Epic `Completed` without explicit Epic acceptance.

## TODO dossier lifecycle

A TODO dossier under `docs/todo/` is a temporary execution SOT for an adopted Epic:

1. Adoption lists the dossier in [`docs/todo/README.md`](todo/README.md), identifies its owning Epic, and links it from [`docs/roadmap/README.md`](roadmap/README.md) as `Detailed SOT`.
2. Before Epic closeout, promote durable behavior, module structure, CLI contracts, and verification guidance into canonical documents (`README.md`, `HERDR.md`, `docs/app-server.md`, `docs/toolchains.md`).
3. Closeout removes the temporary dossier and its [`docs/todo/README.md`](todo/README.md) entry, replaces `Detailed SOT` with `Canonical Outcomes` in [`docs/roadmap/README.md`](roadmap/README.md), and then marks the Epic `Completed` after explicit acceptance. Git history preserves the retired dossier.

## Documentation checks

For documentation-only changes, verify relative Markdown links and anchors, check `git diff --check`, and run `./dev test` to confirm the baseline offline suite remains untouched and passing.
