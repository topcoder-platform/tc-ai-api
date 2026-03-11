---
name: jd-skills-extraction
description: Extracts a flat list of technical and soft skill keywords from job descriptions using canonical casing. Use when identifying all skills mentioned or implied by a JD for tagging and matching purposes.
metadata:
  author: topcoder
  version: '1.0'
  concern: skill-keyword-extraction
  priority: high
---

# JD Skills Extraction

Extract a flat array of skill keyword strings from the rewritten job
description content. These keywords are used for tagging, search, and
candidate matching on the Topcoder platform.

## What to Include

- **Programming languages**: TypeScript, JavaScript, Python, Java, Go, Rust, C#, etc.
- **Frameworks**: React, Angular, Vue, NestJS, Express, Django, Spring Boot, .NET, etc.
- **Libraries & ORMs**: Prisma, Sequelize, Mongoose, Redux, TailwindCSS, etc.
- **Cloud platforms**: AWS, GCP, Azure, Vercel, Heroku, DigitalOcean, etc.
- **Databases**: PostgreSQL, MongoDB, Redis, MySQL, DynamoDB, Elasticsearch, etc.
- **DevOps & tools**: Docker, Kubernetes, Terraform, GitHub Actions, Jenkins, etc.
- **Protocols & standards**: REST, GraphQL, gRPC, WebSocket, OAuth, JWT, OpenAPI, etc.
- **Methodologies**: Agile, Scrum, TDD, CI/CD, Microservices, etc.
- **Soft skills**: Communication, Problem Solving, Team Collaboration, Leadership, etc.

## Canonical Casing Rules

Always use the official casing for technology names:

| Correct       | Incorrect                         |
|---------------|-----------------------------------|
| TypeScript    | typescript, Typescript, TS        |
| JavaScript    | javascript, Javascript, JS        |
| PostgreSQL    | postgresql, Postgres, postgres    |
| NestJS        | nestjs, Nest.js, nest             |
| Node.js       | nodejs, NodeJS, node              |
| React         | react, ReactJS, React.js         |
| Vue           | vue, VueJS, Vue.js               |
| Angular       | angular, AngularJS               |
| Docker        | docker                           |
| Kubernetes    | kubernetes, K8s                   |
| OAuth         | oauth, Oauth, oAuth              |
| GraphQL       | graphql, Graphql                  |
| MongoDB       | mongodb, Mongodb, mongo           |
| Redis         | redis                            |
| AWS           | aws, Aws                         |
| GCP           | gcp                              |
| Azure         | azure                            |
| REST          | rest, Rest                       |
| CI/CD         | cicd, Cicd, ci/cd                |
| TailwindCSS   | tailwindcss, Tailwind CSS        |

For soft skills, use title case: "Problem Solving", "Team Collaboration".

## Extraction Heuristics

### Explicit Skills

Directly mentioned technologies and qualifications:
- "Experience with React and Node.js" → `["React", "Node.js"]`
- "PostgreSQL database" → `["PostgreSQL"]`

### Implicit Skills

Technologies implied but not named directly:
- "REST API development" → `["REST"]` (and the language/framework if stated)
- "containerized deployment" → `["Docker"]` (unless another container tool is specified)
- "cloud infrastructure" → extract the specific platform if mentioned, otherwise omit
- "version control" → `["Git"]`
- "CI/CD pipeline" → `["CI/CD"]`

### Compound Terms

Split combined technologies into separate entries:
- "React/Redux" → `["React", "Redux"]`
- "Node.js with Express" → `["Node.js", "Express"]`
- "AWS (S3, Lambda, DynamoDB)" → `["AWS", "Amazon S3", "AWS Lambda", "DynamoDB"]`

## Output Rules

- Return a flat array of strings.
- 5-15 keywords is ideal.
- No duplicates.
- Order: most relevant to the role first.
- Include both technical and soft skills when present in the source.
- Do NOT invent skills not supported by the source material.
