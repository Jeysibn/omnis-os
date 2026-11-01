# User Stories and Acceptance Scenarios

## U-01 - Create an employee

**Given** I am signed in as director, **when** I create Atlas with a Systems Architect profession and thoughtful personality and assign it to Engineering, **then** the system stores the profile, its version, and department membership without granting privileged tools. Changing the model later does not erase identity or history.

## U-02 - Start work on a project

**Given** a project with milestones, **when** I add a task with acceptance criteria and select an agent, **then** a task run is created after policy checks, and I can see distinct task status and execution status.

## U-03 - Runtime returns partial/failure

**Given** a running agent, **when** it stops with a partial result or rate-limit error, **then** the run is not accepted as successful. I see a failure/interruption reason, event history, and safe options to retry after reviewing side effects.

## U-04 - Private profile chat is isolated

**Given** Atlas is working on project A, **when** I choose Atlas's profile in Private Chat and ask about project B, **then** the conversation uses a profile snapshot, does not see Atlas's operational thread, does not mutate project A or agent memory, and receives no live tools by default.

## U-05 - Convert conversation to task

**Given** a private chat, **when** I click 'Create task from conversation', **then** the system shows a summary, target project, assignee, permissions, and requested actions for human confirmation. No task runs on click alone.

## U-06 - Approve a sensitive operation

**Given** Nova requests writing to a protected branch, **when** the application prompts for approval, **then** the exact action, target, reason, expiration, run ID and permissions are visible. Denial blocks execution and is audited.

## U-07 - Add reusable capability

**Given** I import a GitHub Skill or MCP server, **when** it is inspected, **then** untrusted instructions or tools are not automatically executable. Only approved pinned content and separately granted tools reach the runtime.

## U-08 - Share verified knowledge

**Given** Sentry discovers a root cause, **when** it proposes a Second Brain entry, **then** the proposal includes source evidence, scope and author. Other agents see the information as trusted only after publishing review.

## U-09 - Run a recurring job

**Given** an 08:00 Asia/Manila daily health-check automation, **when** the scheduler fires, **then** it creates an occurrence and task run with one idempotency key. A retry or restarted scheduler cannot silently create a duplicate run.

## U-10 - Handle outage on schedule

**Given** the app is down at scheduled time, **when** it restarts, **then** configured missed-run policy (skip or once) is applied and recorded, with no surprise backlog of destructive actions.

## U-11 - Show honest cost data

**Given** an OAuth subscription task with 1200 reported tokens and no invoice data, **when** I view usage, **then** tokens and any reference API value are visible, and actual incremental charge is **unknown or subscription-included** based on evidence, never assumed equal to reference API value.

## U-12 - Show 3D office activity

**Given** Nova's persisted status changes to running, **when** I open the office, **then** her avatar is shown working. On refresh it reconstructs status; if the runtime goes offline, the scene shows disconnected instead of continuing fictional typing.

## U-13 - Permission isolation across projects

**Given** Scout has access only to Research Project A, **when** it searches Second Brain or uses MCP, **then** it cannot retrieve Project B knowledge, tools or credentials by guessing identifiers.

## U-14 - Cancel a task

**Given** a running agent, **when** I cancel it, **then** control plane requests stop and reports cancellation pending until runtime acknowledges or a timeout marks the state uncertain; it never claims rollback of already executed external side effects.

## U-15 - Shared subscription limits

**Given** private chat and operational agents use one subscription, **when** provider rate limits are reached, **then** lower priority work queues/waits, the system displays capacity status honestly, and it does not silently switch to paid API keys.
