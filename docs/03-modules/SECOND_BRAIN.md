# Module - Shared Second Brain

## Mission

A shared, queryable, trustworthy knowledge base independent of Claude, Codex, and Hermes. It helps agents build on reviewed findings without sharing private working context by accident.

## Four distinct knowledge scopes

1. **Global Organizational Knowledge:** approved policies, SOPs, architecture principles and general references.
2. **Project Knowledge:** requirements, decisions, technical notes, findings scoped to authorized project members.
3. **Personal Agent Memory:** each employee's private working knowledge. Not automatically published.
4. **Run/Chat Records:** raw execution or conversation history. Evidence but not trusted knowledge.

## Proposed storage

- Canonical reviewed documents: Git-versioned Markdown vault (Obsidian compatible but Obsidian app is optional).
- PostgreSQL: document metadata, scope/ACL, reviews, versions, references and search index.
- Search: PostgreSQL keyword/full-text first; optional pgvector hybrid retrieval after data quality tests.
- Embeddings: local Ollama optional; store model ID/dimension/version, rebuild index on change; avoid paid embedding defaults.
- Attachments/artifacts: controlled storage paths/checksums, not uncontrolled remote URLs.

## Workflow

`draft or agent proposal -> scope/classify -> source validation -> review -> approved/published revision -> chunk/index -> retrieval -> supersede/retire as needed`.

A contribution includes subject, confidence type (`confirmed`, `hypothesis`, `recommendation`), originating run and source citations, classification, author, and applicable project/scope. 'Confirmed' requires referenced evidence; it is not a model sentiment score.

## Retrieval interface

Agent-facing knowledge tool operations:
- `knowledge_search(query, scope, limit)` returns IDs, titles, relevance and permission-safe snippets.
- `knowledge_read(doc_id, revision?)` returns authorized Markdown and source metadata.
- `knowledge_propose(title, scope, content, citations, evidence_class)` creates review request.
- `knowledge_review(proposal_id, decision)` reserved for authorized human or explicitly delegated reviewer policy.

Search must filter authorization **before** showing candidates and again before returning content; embeddings and index records must not leak unapproved project content. Cite immutable revision IDs in every answer as an app reference.

## Duplicate and contradiction handling

- Match by stable topic/project and content similarity; do not auto overwrite.
- Conflicting facts remain explicit unresolved alternatives pending human review.
- Mark superseded docs and preserve history. Use effective date and source date to avoid stale decisions.
- Retention and deletion: provide bounded lifecycle for private memory and raw logs; take care with backups and derived indexes.

## Isolation

- Agent memory is not automatically indexed into global knowledge.
- Private Chat has no knowledge access by default; opt-in permits read-only specified project scopes.
- Runtime home directories (e.g., multiple Hermes profiles) must remain separate; they use Second Brain through a shared authorized interface instead of a shared writable model memory file.

## Suggested vault structure

```text
knowledge-vault/
  organization/
    policies/
    standards/
    runbooks/
  projects/
    project-key/
      requirements/
      decisions/
      architecture/
      research/
      incidents/
  archive/
```

Canonical reference path is a safe indexed object ID, not a raw user path. Avoid requiring direct vault Git writes from the inference process.

## Acceptance

- Scout searches project A and cannot find project B-only notes.
- Two agent proposals for same decision are reviewed rather than silently overwriting each other.
- Approved knowledge with source citation is retrievable by another agent after restart.
- Updating a published doc reindexes the correct revision and removes unauthorized stale snippets.
- If Ollama embeddings are unavailable, keyword search remains functional and UI indicates degraded semantic search.
