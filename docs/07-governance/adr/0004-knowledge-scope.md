# ADR-0004: Shared Reviewed Knowledge Outside Runtime Memories

- **Status:** Accepted product direction; storage design proposed
- **Date:** 2026-11-02

## Context

Employees using different runtimes need common project facts without sharing their private thoughts, run logs, or subscription home directories. A shared writable memory file risks corruption and accidental data leakage.

## Options

1. Share all runtime home memories directly - poor isolation and version management.
2. Dedicated vector DB alone - searchable but not a clear human-governed source of truth.
3. Versioned Markdown vault with database metadata/ACL and optional search indexes - transparent, reviewable, portable.

## Decision

Use option 3. Independent agent memory is separate; shared Second Brain updates are proposals and reviewed revisions. Search index is derived and rebuildable. Optional pgvector/local embeddings are secondary, not canonical.

## Consequences

- Knowledge publication workflow adds deliberate friction for trustworthy facts.
- Permissions need enforcement before retrieval, during retrieval and in indexes.
- Git/DB/artifact backups must be coordinated for reliable restores.

## Revisit when

Knowledge volume, retrieval quality, or multi-user collaboration demonstrates a need for a specialized graph or document platform.
