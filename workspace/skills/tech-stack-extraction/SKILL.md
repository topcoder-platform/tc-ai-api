---
name: tech-stack-extraction
description: Extracts technology stack from challenge specifications including programming languages, frameworks, libraries, databases, cloud services, and protocols. Use when identifying all technologies mentioned or implied by a challenge description.
metadata:
  author: topcoder
  version: '1.0'
  concern: technology-detection
  priority: high
---

# Tech Stack Extraction

Return a flat array of technology/framework/tool names mentioned or implied
by the specification.

## What to Include

- **Programming languages**: TypeScript, JavaScript, Python, Java, Go, Rust, etc.
- **Frameworks**: React, Angular, Vue, NestJS, Express, Django, Spring Boot, etc.
- **Libraries**: Prisma, Sequelize, Lodash, Axios, etc.
- **Cloud services**: AWS, GCP, Azure, Vercel, Heroku, etc.
- **Databases**: PostgreSQL, MongoDB, Redis, MySQL, DynamoDB, etc.
- **Protocols**: REST, GraphQL, gRPC, WebSocket, OAuth, SAML, etc.
- **Dev tools**: Docker, Kubernetes, GitHub Actions, Jest, Vitest, ESLint, etc.

## Naming Rules

Always use **canonical casing**:

| Correct    | Incorrect              |
| ---------- | ---------------------- |
| TypeScript | typescript, Typescript |
| JavaScript | javascript, Javascript |
| PostgreSQL | postgresql, Postgres   |
| NestJS     | nestjs, Nest.js        |
| Node.js    | nodejs, NodeJS         |
| React      | react, ReactJS         |
| Docker     | docker                 |
| OAuth      | oauth, Oauth           |

## Implicit Technology Detection

Sometimes technologies are implied but not named. Look for:

- `package.json` → Node.js / JavaScript / TypeScript ecosystem
- `requirements.txt` or `pyproject.toml` → Python
- `pom.xml` or `build.gradle` → Java
- `go.mod` → Go
- `Cargo.toml` → Rust
- `Dockerfile` → Docker
- `.github/workflows/` → GitHub Actions
- "REST API" → REST protocol
- "JWT tokens" → JWT, possibly OAuth
- Database connection strings → specific database technology

## What NOT to Include

The tech stack should only contain technologies the **submitter builds with**.
Do NOT include:

- **Platform review / CI infrastructure** that the submission is evaluated
  against but does not use at build time. Examples: SAST scanners,
  vulnerability scanners, code quality gates, review bots.
- **Topcoder platform tooling**: copilot tools, scorecard systems,
  challenge submission portals, review workflows.
- **Conditional / optional technologies** unless the spec makes them
  mandatory. If the spec says *"if you use AI…"* or *"optionally…"*,
  do NOT include those technologies as definite stack items.
- **Generic categories** that aren't specific technologies:
  "Security", "Testing", "CI/CD" (unless a specific tool is named).

### Examples of Incorrect Tech Stack Items

| Spec says…                                         | Wrong item               | Why                                    |
| -------------------------------------------------- | ------------------------ | -------------------------------------- |
| "must pass SAST and vulnerability scanners"         | "SAST Scanner"           | Platform infra, not submitter tech     |
| "AI reviewers are active on the platform"           | "AI Reviewer"            | Topcoder tooling                       |
| "If you use AI, implement with Ollama or OpenAI"    | "OpenAI API"             | Conditional — not required             |
| "We will evaluate on documentation quality"         | "Documentation"          | Not a technology                       |

## Output Format

Flat array of strings, each a technology name in canonical casing:

```json
["TypeScript", "NestJS", "PostgreSQL", "Prisma", "Docker", "REST", "JWT"]
```
