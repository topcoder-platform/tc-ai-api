---
name: submission-guidelines-extraction
description: Extracts structured submission information from challenge specifications including deliverables, packaging format, submission type, storage, and eligibility conditions. Use when parsing what submitters must deliver and how.
metadata:
  author: topcoder
  version: '1.0'
  concern: submission-parsing
  priority: critical
---

# Submission Guidelines Extraction

Extract structured submission information from the challenge specification
into dedicated fields.

## Required Fields

### 1. `summary`

Write a concise 1-3 sentence overview of what submitters must deliver and how.

### 2. `whatToSubmit`

List ONLY deliverables the specification **explicitly asks the submitter to
deliver or include**. Each item is a separate array entry. Common deliverables:

- Source code
- README with setup instructions
- Postman collection
- Docker configuration
- Unit tests
- Demo video
- Deployment guide
- Environment configuration template
- Database migration scripts

#### What NOT to include

- Do NOT add deliverables inferred from **evaluation criteria** or **review
  rubrics**. If the scorecard mentions "code comments" or "security", that
  does not mean "comments" or "security report" are deliverables.
- Do NOT add "test cases" or "unit tests" unless the spec explicitly says
  to **submit** them (e.g. "include unit tests in your submission").
  Mentioning testing in the evaluation criteria is NOT the same as requiring
  tests as a deliverable.
- Do NOT list "documentation" as a separate item when "README" or
  "README.md" is already listed — the README **is** the documentation.
- Do NOT infer deliverables from general best practices. Only extract what
  the challenge author explicitly requested.
- When in doubt, **leave it out**.

### 3. `howToSubmit`

How to package the submission:

- ZIP archive
- Git patch
- Single commit on a feature branch
- Pull request
- Docker image

### 4. `whereToSubmit`

Where to deliver the submission:

- Topcoder challenge page
- GitHub pull request
- External URL

**Default:** "Topcoder challenge page" when unspecified.

### 5. `submissionType`

Pick exactly one:

| Type                 | When                                          |
| -------------------- | --------------------------------------------- |
| `full_codebase`      | Entire project/repo must be submitted         |
| `patch`              | Only a diff/patch on top of existing codebase |
| `link_to_repository` | Provide a URL to a Git repository             |
| `link_to_deployment` | Provide a URL to a running deployment         |
| `file_upload`        | Upload one or more files (ZIP, PDF, etc.)     |
| `other`              | None of the above                             |

### 6. `submissionStorage`

Where the final artifact lives:

| Storage                 | When                                               |
| ----------------------- | -------------------------------------------------- |
| `topcoder_upload`       | Uploaded directly to the Topcoder platform         |
| `git_repository`        | Pushed to a Git repo (GitHub, GitLab, etc.)        |
| `external_file_storage` | Hosted on S3, Google Drive, Dropbox, etc.          |
| `cloud_deployment`      | Live on a cloud environment (Heroku, Vercel, etc.) |
| `other`                 | None of the above                                  |

**Default:** `topcoder_upload` when unspecified.

### 7. `isPatchOfExisting`

Set to `true` ONLY when ALL of the following are true:
1. The challenge explicitly asks for a patch, diff, or incremental change
2. An existing codebase is provided (repository URL, starter code, etc.)
3. The existing_codebase.isGreenfield is `false`

Set to `false` when:
- The full codebase should be submitted
- It is a greenfield project (no existing code to patch)
- No concrete repository URL or code artifacts are referenced

**CRITICAL CONSISTENCY CHECK:** 
`isPatchOfExisting` can ONLY be `true` when there is actual code to patch.
If `existing_codebase.isGreenfield` is `true` (no existing codebase), then
`isPatchOfExisting` MUST be `false` — you cannot create a patch against
code that doesn't exist.

| existing_codebase.isGreenfield | isPatchOfExisting | Valid? |
|-------------------------------|-------------------|--------|
| `true`                        | `false`           | YES    |
| `true`                        | `true`            | NO - contradiction! |
| `false`                       | `false`           | YES (full code submission) |
| `false`                       | `true`            | YES (patch of existing) |

**Common mistake:** Challenge mentions "enhance", "update", or "extend"
existing functionality but does NOT provide an actual repository URL or
starter code. This is still a greenfield project — the submitter must
build everything from scratch. Do NOT set `isPatchOfExisting: true`.

### 8. `eligibilityConditions`

Capture any hard gates. Examples:

- "must pass SAST"
- "must include unit tests with ≥80% coverage"
- "no linting errors"
- "must build without warnings"
- "must include Docker configuration"

Return an **empty array** if none are mentioned.

### 9. `notes`

Any remaining submission information that doesn't fit the fields above.

## Detection Heuristics

| Challenge Text                                 | Extracted Field                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| "Submit a ZIP file of your solution"           | `submissionType: "file_upload"`, `howToSubmit: "ZIP archive"`                   |
| "Create a pull request against the dev branch" | `submissionType: "patch"`, `isPatchOfExisting: true`                            |
| "Deploy to Heroku and provide the URL"         | `submissionType: "link_to_deployment"`, `submissionStorage: "cloud_deployment"` |
| "Push your code to the provided repository"    | `submissionType: "link_to_repository"`, `submissionStorage: "git_repository"`   |
| No submission section found                    | Use defaults: `topcoder_upload`, `file_upload`                                  |

## Common Mistakes to Avoid

| Spec says…                                                 | Wrong whatToSubmit        | Why it's wrong                                                |
| ---------------------------------------------------------- | ------------------------ | ------------------------------------------------------------- |
| "submissions must pass SAST scanner"                       | "Test cases"             | SAST is an eligibility condition, not a deliverable           |
| "We will evaluate on: documentation"                       | "Documentation"          | Evaluation criteria ≠ submission deliverable                  |
| "Include a README.md"                                      | "README.md", "Documentation" | Redundant — README is the documentation                  |
| "Your code should include tests" (in evaluation section)   | "Test cases"             | Evaluation guidance, not an explicit submission requirement   |
| "Security will be reviewed"                                | "Security report"        | Review criteria, not a deliverable                            |

## isPatchOfExisting Mistakes to Avoid

| Spec says…                                                 | Wrong isPatchOfExisting | Why it's wrong                                                |
| ---------------------------------------------------------- | ---------------------- | ------------------------------------------------------------- |
| "Enhance the existing processor" (no repo URL provided)    | `true`                 | No actual repo/code to patch — this is greenfield             |
| "Update the Lambda to handle X" (describes current system) | `true`                 | Description of current state ≠ existing codebase to patch     |
| "We did a POC challenge previously"                        | `true`                 | Past work ≠ code artifact provided for this challenge         |
| isGreenfield=true in existing_codebase                     | `true`                 | **CONTRADICTION** — cannot patch non-existent code            |
