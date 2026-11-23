# Active TODO dossiers

This directory holds temporary execution source-of-truth (SOT) dossiers for adopted `herdr-zcode` Epics. The [roadmap](../roadmap/README.md) alone owns Epic and Task identity, ordering, dependencies, and status.

## Adopted dossiers

| Dossier | Owning Epic | Purpose | Retirement condition |
| --- | --- | --- | --- |
| [TODO-HERDR-CORE-RUNTIME-AND-MULGAE-SUPPORT.md](TODO-HERDR-CORE-RUNTIME-AND-MULGAE-SUPPORT.md) | [EPIC-001](../roadmap/README.md#epic-001-shared-core-herdr-core-runtime-and-mulgae-integration-support) | Detailed module blueprint, exact CLI/protocol/OSC 7501 contracts, anti-regression guardrails, and per-Task implementation checklists for `TASK-001` through `TASK-006`. | Promote durable outcomes to canonical docs (`README.md`, `HERDR.md`, `docs/app-server.md`, `docs/toolchains.md`), replace `Detailed SOT` with `Canonical Outcomes` in `docs/roadmap/README.md`, and remove this file and row at `EPIC-001` closeout. |

## Lifecycle rule

- Do not track status checkboxes or duplicate roadmap status tables inside a dossier; update status only in [`docs/roadmap/README.md`](../roadmap/README.md).
- Remove each temporary dossier and its table entry here once its owning Epic promotes durable outcomes and receives explicit acceptance.
