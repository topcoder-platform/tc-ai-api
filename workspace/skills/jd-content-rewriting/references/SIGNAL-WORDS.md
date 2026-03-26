# Signal Words Reference for JD Classification

## Requirement Signals (Mandatory)

These words indicate a mandatory qualification or responsibility:

- **must** — "Must have 3+ years of experience"
- **required** — "Required: Bachelor's degree in CS"
- **mandatory** — "Mandatory experience with Docker"
- **essential** — "Essential skills include TypeScript"
- **critical** — "Critical: understanding of security best practices"
- **need** / **needs** — "We need someone who can..."
- **will be expected** — "You will be expected to deliver..."
- **responsible for** — "Responsible for the full deployment pipeline"
- **minimum** — "Minimum 5 years of relevant experience"

## Nice to Have Signals (Optional)

These words indicate a preferred but non-mandatory qualification:

- **nice to have** — "Nice to have: Kubernetes experience"
- **preferred** — "Preferred: experience with microservices"
- **ideally** — "Ideally, the candidate has worked with GraphQL"
- **bonus** — "Bonus: familiarity with Terraform"
- **plus** — "AWS certification is a plus"
- **optional** — "Optional: experience with CI/CD pipelines"
- **desired** — "Desired: understanding of event-driven architecture"
- **advantage** — "Knowledge of Go would be an advantage"
- **beneficial** — "Experience with mobile development is beneficial"
- **should** (soft) — "Should have some exposure to..."
- **extra credit** — "Extra credit for experience with..."

## Ambiguous Signals

These require context to classify correctly:

- **should** — Can be mandatory or preferred depending on tone.
  - "Should have 5+ years" → likely Requirement
  - "Should ideally know React" → likely Nice to Have
- **expected** — Usually mandatory unless softened.
  - "Expected to write tests" → Requirement
  - "Would be expected to occasionally..." → Softer, could be either
- **knowledge of** — Depends on phrasing.
  - "Strong knowledge of SQL required" → Requirement
  - "Some knowledge of Kubernetes" → Nice to Have

## Default Classification Rule

When no signal word is present, classify based on role relevance:

| Context                                    | Default         |
|--------------------------------------------|-----------------|
| Core technical skill for the role          | Requirement     |
| Domain expertise matching the project      | Requirement     |
| Adjacent or supplementary skill            | Nice to Have    |
| Soft skill or methodology                  | Nice to Have    |
| Specific tool version or certification     | Nice to Have    |
