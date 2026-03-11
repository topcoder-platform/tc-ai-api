---
name: jd-structure-formatting
description: Formats job descriptions into a standardized Topcoder opportunity structure with consistent sections, headings, and Markdown formatting. Use when rewriting a raw JD to ensure every output follows the canonical section order and formatting conventions.
metadata:
  author: topcoder
  version: '1.0'
  concern: jd-formatting
  priority: critical
---

# Job Description Structure & Formatting

Rewrite every job description into the canonical Topcoder opportunity
format below. The raw input may be unstructured prose, bullet soup,
email fragments, or a mix — normalise it into this exact structure.

## Canonical Section Order

Every rewritten JD **MUST** contain these sections in this order:

1. **Title**
2. **Overview**
3. **Responsibilities**
4. **Requirements**
5. **Nice to Have**
6. **Skills**

Do NOT add extra sections. Do NOT reorder sections.

## Section Formatting Rules

### 1. Title

- A single line, no Markdown heading prefix in the JSON field.
- Concise and descriptive (≤ 10 words).
- If the raw JD has no title, infer one from the role and domain.
- Use title case (e.g. "Senior Full-Stack Developer — Payments Platform").

### 2. Overview

- 2-4 sentences maximum.
- First sentence: what the project or product is.
- Second sentence: the team, client, or business context.
- Third/fourth sentence: the primary goal of this opportunity.
- Do NOT repeat information that belongs in Responsibilities or Requirements.

### 3. Responsibilities

- Bullet list (Markdown `- ` prefix).
- Each bullet starts with an action verb (e.g. "Design", "Implement",
  "Collaborate", "Optimize", "Review").
- Each bullet is one concrete task or deliverable.
- Order: most important first.
- 5-10 bullets is ideal; never exceed 15.

### 4. Requirements

- Bullet list.
- Each bullet is a mandatory qualification: skill, experience level,
  technology proficiency, certification, or domain expertise.
- Be specific: "3+ years of experience with React" not "frontend experience".
- Order: most critical first.
- 4-8 bullets is ideal; never exceed 12.

### 5. Nice to Have

- Bullet list.
- Preferred but non-mandatory qualifications.
- If the raw JD has no optional items, include 2-3 reasonable ones
  inferred from the role context — but mark them clearly as preferred.
- 2-5 bullets is ideal.

### 6. Skills

- Flat array of keyword strings (not a bullet list in the formatted output).
- Use canonical casing (see jd-skills-extraction skill).
- 5-15 keywords covering both technical and soft skills.
- No duplicates.

## Markdown Formatting in `formattedDescription`

The `formattedDescription` field must be valid Markdown:

```
## Title

[overview text]

## Responsibilities

- Verb-led bullet
- Verb-led bullet

## Requirements

- Specific qualification
- Specific qualification

## Nice to Have

- Preferred qualification

## Skills

React, Node.js, PostgreSQL, REST APIs, Agile
```

- Use `##` for section headings.
- One blank line between sections.
- No trailing whitespace.
- No HTML tags.
