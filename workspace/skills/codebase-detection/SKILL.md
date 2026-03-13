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

Set `isGreenfield` to **true** when the challenge requires building the
submission from scratch and provides **no code artifacts to build upon**.

Set `isGreenfield` to **false** ONLY when the challenge provides actual
code, templates, or starter projects that the submitter must fork, clone,
extend, or modify.

### What is NOT an existing artifact

URLs and references in the spec often point to **external resources the
submission must consume or interact with**, not code to build upon:

- **API endpoints** the submission calls (e.g. `https://api.example.com/v5`)
  are external dependencies, NOT starter code.
- **Reference repositories** linked for documentation purposes (e.g. a
  GitHub link to an API's source for reading its docs) are NOT artifacts
  unless the spec explicitly says to fork, clone, or extend that repo.
- **Third-party services** (GitHub API, Stripe, Twilio, etc.) are
  integrations, NOT existing codebase artifacts.
- **Documentation links** (Swagger/OpenAPI docs, README references) are
  informational resources, NOT code artifacts.

### Decision heuristic

| Spec language                                          | isGreenfield | Reasoning                              |
| ------------------------------------------------------ | ------------ | -------------------------------------- |
| "build a CLI app that calls https://api.example.com"   | `true`       | External API to consume, no code given |
| "see https://github.com/org/repo for API docs"         | `true`       | Reference link, not code to extend     |
| "fork https://github.com/org/repo and add features"    | `false`      | Explicit instruction to extend code    |
| "use the provided starter template in the attachment"   | `false`      | Starter code artifact provided         |
| "extend the existing NestJS API in the repository"      | `false`      | Building on existing code              |

**Key rule:** If no spec language tells the submitter to fork, clone,
extend, or modify a specific codebase, default to `isGreenfield = true`.

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
