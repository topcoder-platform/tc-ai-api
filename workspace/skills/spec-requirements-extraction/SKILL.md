---
name: spec-requirements-extraction
description: Extracts individual requirements from Topcoder challenge specifications. Use when parsing a challenge description to identify every distinct piece of work the submitter must deliver, including titles, descriptions, priorities, and constraints.
metadata:
  author: topcoder
  version: '1.0'
  concern: requirements-parsing
  priority: critical
---

# Requirements Extraction

Parse the challenge specification and extract every distinct requirement
a submitter MUST deliver. Challenge descriptions are Markdown written by
copilots with NO fixed template — headings, numbering, bullet styles,
section names, and nesting all vary.

## Extraction Rules

1. **Identify every distinct requirement** in the specification.
   A "requirement" is any piece of work the submitter MUST deliver.
   Look for:
   - Numbered sections
   - Bullet lists
   - Paragraphs describing expected functionality
   - API endpoints
   - UI components
   - Integrations
   - Data models

2. **Assign sequential IDs**: `REQ_01`, `REQ_02`, …

3. **Write a concise `title`** (≤ 12 words) and a thorough `description`
   that preserves all technical detail from the source text.

4. **Determine `priority`**:

   | Priority   | Signal Words                                                                             |
   | ---------- | ---------------------------------------------------------------------------------------- |
   | **high**   | "must", "required", "critical", "mandatory", "essential", "will not be accepted without" |
   | **medium** | "should", "recommended", "ideally", "preferred"                                          |
   | **low**    | "nice to have", "optional", "bonus", "extra credit"                                      |

   If unclear, **default to high**.

5. **Extract `constraints`** — any explicit restrictions, limits, format
   rules, compatibility requirements, error-handling mandates, or
   performance criteria attached to that requirement.

   Give each constraint a sequential ID scoped to its requirement:
   `CONS_<reqNum>_1`, `CONS_<reqNum>_2`, …

## Examples

**Input fragment:**

> The API **must** support pagination with cursor-based navigation.
> Response time should be under 200ms.

**Output:**

```json
{
  "id": "REQ_03",
  "title": "Cursor-based API pagination",
  "description": "The API must support pagination with cursor-based navigation for all list endpoints.",
  "priority": "high",
  "constraints": [
    {
      "id": "CONS_03_1",
      "description": "Response time should be under 200ms"
    }
  ]
}
```

## Edge Cases

- If a single paragraph contains multiple independent requirements,
  split them into separate entries.
- If a requirement is implied but not explicitly stated (e.g. error
  handling for an API endpoint), include it with priority "medium".
- Configuration and environment setup instructions are requirements
  too — capture them.

See [requirement patterns reference](references/REQUIREMENT-PATTERNS.md) for common challenge patterns.
