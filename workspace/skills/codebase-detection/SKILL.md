---
name: codebase-detection
description: Determines whether a challenge provides pre-existing artifacts (repos, starter code, APIs, designs) or is greenfield. Use when analyzing a challenge specification to identify starting-point artifacts, their types, URLs, and existing technology present in provided code.
metadata:
  author: topcoder
  version: '1.0'
  concern: artifact-detection
  priority: high
---

# Existing Codebase / Starting-Point Detection

Determine whether the challenge provides ANY pre-existing artifacts that
serve as a starting point for submitters.

## Artifact Scanning Checklist

Look for references to:

- [ ] Git repositories, repo URLs, branches, or tags
- [ ] Starter code, boilerplate, templates, or seed projects
- [ ] API specifications (Swagger / OpenAPI), Postman collections
- [ ] Figma / Zeplin / design documents or wireframes
- [ ] Existing documentation, architecture diagrams
- [ ] Datasets, database dumps, CSV/JSON data files
- [ ] Configuration files, environment templates
- [ ] Libraries or packages the submitter must use

## Greenfield Determination

Set `isGreenfield` to **true** ONLY when the challenge **explicitly** requires
building everything from scratch with **zero provided artifacts**.

If ANY artifact exists → `isGreenfield = false`.

## Artifact Classification

For each artifact found, identify its `type`:

| Type            | Description                             |
| --------------- | --------------------------------------- |
| `repository`    | Full Git repository to fork/clone       |
| `starter_code`  | Partial code that submitters extend     |
| `boilerplate`   | Project scaffold / template             |
| `documentation` | Written specs, architecture docs        |
| `api_spec`      | Swagger/OpenAPI/Postman definitions     |
| `design`        | Figma, Zeplin, wireframes, mockups      |
| `dataset`       | CSV, JSON, database dumps, sample data  |
| `database_dump` | SQL dump or migration files             |
| `config`        | Environment templates, Docker configs   |
| `library`       | Required packages or internal libraries |
| `other`         | Anything not fitting above categories   |

## Existing Technology Detection

Note which programming languages and frameworks are **ALREADY present** in the
existing codebase. These may differ from what the challenge requirements ask for.

Example: The repo is a NestJS project, but the challenge asks to add a React
frontend. Existing tech = `["TypeScript", "NestJS", "Prisma"]`.

## Summary Writing

Write a concise `summary` of the starting-point status:

**Good examples:**

- "Existing NestJS API with Prisma ORM — extend with new endpoints"
- "React + Vite starter with authentication already implemented"
- "Greenfield — build from scratch"
- "Existing Python data pipeline — add new processing stages"

**Bad examples:**

- "There is a repository" (too vague)
- "Code exists" (no useful information)
