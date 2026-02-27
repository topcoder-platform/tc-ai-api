---
name: requirement-grouping
description: Groups extracted requirements into logical clusters by feature area or problem domain. Use after requirements extraction to organize requirements into named groups, ensuring every requirement appears in exactly one group.
metadata:
  author: topcoder
  version: '1.0'
  concern: requirements-organization
  priority: high
---

# Requirement Grouping

After extracting all requirements, group them by the feature area, story,
or problem domain they belong to.

## Grouping Rules

1. **Identify logical clusters** — requirements that serve the same
   high-level feature or solve the same problem should be in one group.

   Examples: "Energy Monitoring", "User Authentication", "API Integration",
   "Data Pipeline", "Frontend Components", "DevOps & Deployment".

2. **Assign sequential IDs**: `GRP_01`, `GRP_02`, …

3. **Give each group a short, descriptive `name`** (≤ 5 words).

4. **List the `requirementIds`** that belong to that group (order by REQ id).

5. **Every requirement MUST appear in exactly one group.**
   If a requirement does not clearly fit any multi-requirement group,
   place it in a catch-all group named **"General"**.

6. If the entire challenge is a single story with no meaningful sub-areas,
   return a **single group** containing all requirement IDs.

## Grouping Heuristics

| Signal                                   | Suggested Group                            |
| ---------------------------------------- | ------------------------------------------ |
| Multiple endpoints for the same resource | Group by resource (e.g. "User Management") |
| Frontend + Backend for same feature      | Group by feature (e.g. "Dashboard")        |
| Setup, config, deployment scattered      | "Infrastructure & Setup" group             |
| Testing requirements across features     | "Testing & Quality" group                  |
| README, docs, comments                   | "Documentation" group                      |

## Validation Checklist

Before finalizing groups:

- [ ] Every REQ_XX ID appears in exactly one group
- [ ] No group has 0 requirements
- [ ] Group names are concise and descriptive
- [ ] Requirements within a group are logically related
- [ ] IDs in `requirementIds` arrays are ordered numerically
