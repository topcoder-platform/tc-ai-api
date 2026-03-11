---
name: jd-content-rewriting
description: Rewrites raw, vague, or poorly written job description text into clear, professional, and specific language. Use when transforming rough JD content into polished prose while preserving all factual information from the source.
metadata:
  author: topcoder
  version: '1.0'
  concern: jd-content-quality
  priority: critical
---

# Job Description Content Rewriting

Transform raw JD text into clear, professional, specific language suitable
for a public Topcoder opportunity posting.

## Core Rewriting Principles

1. **Preserve all facts** — Never invent requirements, technologies,
   experience levels, or responsibilities not present or clearly implied
   in the source material.

2. **Clarify vagueness** — Rephrase ambiguous statements into specific,
   actionable items.

   | Raw (vague)                       | Rewritten (specific)                                           |
   |-----------------------------------|----------------------------------------------------------------|
   | "work on backend stuff"           | "Design and implement RESTful API endpoints"                   |
   | "know databases"                  | "Experience with relational databases (e.g. PostgreSQL, MySQL)"|
   | "good with frontend"              | "Proficiency in modern frontend frameworks (React, Vue, etc.)" |
   | "handle the cloud"                | "Deploy and manage services on AWS or equivalent cloud platform"|
   | "do testing"                      | "Write and maintain unit and integration tests"                |

3. **Use professional tone** — Formal but approachable. No slang, no
   exclamation marks, no emojis, no ALL CAPS emphasis.

4. **Use inclusive language** — Gender-neutral throughout. Avoid "he/she",
   "guys", "manpower". Use "you", "the candidate", "team members".

5. **Eliminate redundancy** — If the same concept appears multiple times
   in the raw text, consolidate into a single clear statement.

6. **Remove filler** — Strip generic boilerplate not backed by the source
   (e.g. "We are a dynamic company..." when no company context is given).

## Handling Sparse Input

When the raw JD is extremely short or vague (< 50 words):

- Structure whatever information is available into the canonical format.
- In the Overview, note that the description is based on limited input.
- Do NOT pad with invented details.
- Infer reasonable responsibilities and requirements only when the role
  type is clear (e.g. "React developer" implies frontend responsibilities).

## Handling Detailed Input

When the raw JD is long and detailed (> 500 words):

- Distill to essential points — do not produce a longer output than input.
- Merge duplicate or overlapping items.
- Preserve technical specifics (versions, tools, frameworks) exactly.
- Move "nice to have" items that are mixed into requirements to the
  correct section based on signal words (see [signal words reference](references/SIGNAL-WORDS.md)).

## Action Verb Reference

Start every responsibility bullet with a strong action verb:

**Design** | **Implement** | **Develop** | **Build** | **Architect** |
**Integrate** | **Optimize** | **Maintain** | **Review** | **Test** |
**Deploy** | **Configure** | **Monitor** | **Migrate** | **Collaborate** |
**Lead** | **Mentor** | **Document** | **Analyze** | **Troubleshoot**

Avoid weak verbs: "Handle", "Deal with", "Be responsible for", "Help with".

## Priority and Requirement Signals

| Signal Words                                            | Classification |
|---------------------------------------------------------|----------------|
| "must", "required", "mandatory", "essential", "critical"| Requirement    |
| "should", "ideally", "preferred", "desired"             | Nice to Have   |
| "bonus", "nice to have", "optional", "plus", "extra"   | Nice to Have   |

When no signal word is present, default to **Requirement** if it sounds
essential for the role, **Nice to Have** if it sounds supplementary.
