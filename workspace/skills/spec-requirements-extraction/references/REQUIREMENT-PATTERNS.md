# Common Requirement Patterns in Topcoder Challenges

## Pattern 1: API Endpoint Requirements

Challenge describes REST/GraphQL endpoints to implement.

**Signals:** "endpoint", "route", "API", "GET/POST/PUT/DELETE", "CRUD"

**Extract as:** One requirement per endpoint or per logical endpoint group.
Constraints include: request/response schemas, auth requirements, pagination,
rate limits.

## Pattern 2: UI Component Requirements

Challenge asks to build visual components or pages.

**Signals:** "page", "screen", "component", "view", "form", "dashboard"

**Extract as:** One requirement per distinct page/component. Constraints
include: responsive design, accessibility, cross-browser support, design specs.

## Pattern 3: Integration Requirements

Challenge demands connecting to external APIs or services.

**Signals:** "integrate", "connect", "API key", "webhook", "OAuth", SDK names

**Extract as:** One requirement per integration target. Constraints include:
auth method, rate limits, error handling, retry logic.

## Pattern 4: Data Model Requirements

Challenge specifies database schemas or data structures.

**Signals:** "schema", "model", "entity", "table", "collection", "migration"

**Extract as:** One requirement per entity/model. Constraints include:
relationships, validations, indexes, soft delete.

## Pattern 5: DevOps / Infrastructure Requirements

Challenge includes deployment or infrastructure setup.

**Signals:** "Docker", "CI/CD", "deploy", "environment", "Dockerfile", "compose"

**Extract as:** One requirement per infrastructure concern. Constraints
include: platform compatibility, environment variables, health checks.

## Pattern 6: Testing Requirements

Challenge mandates specific test coverage or test types.

**Signals:** "test", "coverage", "unit test", "integration test", "e2e"

**Extract as:** One requirement for testing approach. Constraints include:
minimum coverage percentage, specific frameworks, test data.

## Priority Escalation Heuristic

When the challenge says nothing about priority, use this default mapping:

- Core business logic → high
- Error handling → high
- Authentication/authorization → high
- Documentation → medium
- Testing → medium
- Code style / linting → low
- Performance optimization → medium
- Bonus features → low
