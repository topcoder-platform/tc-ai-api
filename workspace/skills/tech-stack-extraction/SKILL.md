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

## Output Format

Flat array of strings, each a technology name in canonical casing:

```json
["TypeScript", "NestJS", "PostgreSQL", "Prisma", "Docker", "REST", "JWT"]
```
