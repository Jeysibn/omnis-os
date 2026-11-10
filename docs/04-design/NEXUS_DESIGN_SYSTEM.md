# OMNIS NEXUS design system — foundation

OMNIS NEXUS is the platform-wide visual identity of Omnis OS, not only the Command Center theme.
This document describes the shared foundation under `apps/web/src/ui/design/`, how features should
consume it, and how existing screens migrate. Visual direction comes from
`OMNIS_NEXUS_UI_UX_SPEC_V2.md` (deep void surfaces, jade accents, restrained amber, fine borders).

## Status and scope

- The foundation is **additive**: adopting it never restyles another screen. It is consumed by the
  Project Workspace and the Command Center; the other screens have not migrated.
- It is demonstrated by a **development-only showcase** at `/design-system.html` (served by the
  Vite dev server, not linked from the app, not part of the production build).
- The Canvas Reactor (`ui/command-center/reactor/`) stays Command Center-specific and is not part of
  this system. It uses the same palette values, repeated in `reactor/visual.ts` because a canvas
  cannot read CSS variables; keep the two in step.
- No new dependency, no external font or CDN, no new state or navigation system.

## Files

| Path                                                                    | Role                                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `design/design.css`                                                     | Tokens (scoped to `.nx-theme`) and all component styles. Component rules are scoped to `.nx-*` classes. |
| `design/Layout.tsx`                                                     | `NxTheme`, `PageContainer`, `PageHeader`, `Panel`, `InfoGroup`, `TelemetryLabel`                        |
| `design/Controls.tsx`                                                   | `NxButton`, `Field`, `NxInput`, `NxTextarea`, `NxSelect`                                                |
| `design/Status.tsx`                                                     | `StatusBadge`                                                                                           |
| `design/Data.tsx`                                                       | `DataTable`, `SearchFilter`                                                                             |
| `design/States.tsx`                                                     | `LoadingState`, `EmptyState`, `ErrorState`, `ConfirmDialog`                                             |
| `design/index.ts`                                                       | Public exports. Import from here.                                                                       |
| `design/Showcase.tsx`, `design/showcase-main.tsx`, `design-system.html` | Dev-only reference page                                                                                 |
| `ui/design.spec.ts`                                                     | Browser tests (contrast, containment, zoom, axe, focus, behaviour)                                      |

## Tokens

Raw palette values are defined once. Components use **roles**, never raw hex.

| Token                              | Value                 | Use                                                                             |
| ---------------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| `--nx-void`                        | `#060c0e`             | Page background                                                                 |
| `--nx-slate` / `--nx-slate-raised` | `#101c20` / `#162629` | Panels / raised controls                                                        |
| `--nx-edge`                        | `#28433e`             | Decorative hairlines and separators (1.8:1 on void, not for control boundaries) |
| `--nx-jade`                        | `#91f2cd`             | Primary action, selected, healthy                                               |
| `--nx-amber`                       | `#f0bd76`             | Attention and approval                                                          |
| `--nx-frost`                       | `#eaf4ee`             | Primary text                                                                    |
| `--nx-blue`                        | `#648df6`             | Keyboard focus ring only                                                        |
| `--nx-red`                         | `#ff8a8a`             | Failure                                                                         |
| `--nx-border-control`              | `#5b7c72`             | Input and button boundaries (4.3:1 on void, 3.8:1 on slate)                     |

**Semantic roles** (use these in components): `--nx-text`, `--nx-text-muted`, `--nx-text-quiet`,
`--nx-status-ok | attention | danger | info | neutral`, `--nx-surface-page | panel | raised`,
`--nx-border`, `--nx-border-control`, `--nx-focus`.

Semantic colours mean something; **decorative** colours (glows, gradients) must never reuse a
status role. Status colour is always paired with a text label and a distinct shape.

**Type:** `--nx-font-display` (Space Grotesk), `--nx-font-sans` (Inter), `--nx-font-mono`
(IBM Plex Mono). Each stack ends in system fallbacks, and the named families are used only if
installed locally. Nothing is fetched. Self-hosting webfonts is a separate, owner-approved step.

**Space / shape:** `--nx-space-1..6` (4 to 32px), `--nx-radius-sm` 4px, `--nx-radius` 8px,
`--nx-control-height` 40px. **Motion:** `--nx-motion-fast` 120ms, `--nx-motion` 200ms,
`--nx-ease`. All animation and transitions are removed under `prefers-reduced-motion: reduce`.

### Measured contrast (WCAG ratios, computed from the tokens)

| Colour         | on void | on slate | on raised |
| -------------- | ------- | -------- | --------- |
| Frost (text)   | 17.5    | 15.4     | 13.9      |
| Muted text     | 9.4     | 8.3      | 7.5       |
| Quiet text     | 7.6     | 6.7      | 6.0       |
| Jade           | 14.8    | 13.1     | 11.8      |
| Amber          | 11.5    | 10.1     | 9.1       |
| Red            | 8.7     | 7.7      | 6.9       |
| Info           | 10.1    | 8.9      | 8.0       |
| Focus blue     | 6.3     | 5.5      | 5.0       |
| Control border | 4.3     | 3.8      | 3.4       |

Text needs 4.5:1; control boundaries and the focus ring need 3:1. `design.spec.ts` re-checks these
from the colours the browser resolves, so a token edit that breaks contrast fails the test.

## Components and conventions

Wrap a NEXUS page in `NxTheme`. The host page owns the single `<main>` landmark and the skip link
(`PageContainer` is a plain `div`). Each page has one `h1`, supplied by `PageHeader`.

```tsx
import {
  NxTheme,
  PageContainer,
  PageHeader,
  Panel,
  DataTable,
  StatusBadge,
  NxButton,
} from './design/index.js';

<NxTheme>
  <main id="main-content">
    <PageContainer>
      <PageHeader
        eyebrow="PROJECTS"
        title="Projects"
        actions={<NxButton variant="primary">New project</NxButton>}
      />
      <Panel title="Active projects">
        <DataTable
          caption="Active projects"
          columns={cols}
          rows={rows}
          rowKey={(r) => r.id}
          empty={{ title: 'No projects yet', description: 'Create one to begin.' }}
        />
      </Panel>
    </PageContainer>
  </main>
</NxTheme>;
```

| Component                                    | Contract                                                                                                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader`                                 | `title` (the h1), optional `eyebrow`, `description`, `actions`                                                                                                                               |
| `Panel`                                      | `title` (heading, `level` 2 or 3), optional `label`, `actions`, `headingRef` (makes the heading focusable with `tabIndex={-1}` so a host can move focus to it). Region named by its heading. |
| `InfoGroup`                                  | `items: {label, value}[]`, rendered as a real `dl`                                                                                                                                           |
| `NxButton`                                   | `variant` primary / secondary / ghost / danger; defaults to `type="button"`; `busy` sets `aria-busy` + `aria-disabled`, ignores clicks, **stays focusable**                                  |
| `Field`                                      | `label`, `hint`, `error`; child is a render function receiving `{id, aria-describedby, aria-invalid}` to spread onto the control. Error is text, `role="alert"`, and sets `aria-invalid`.    |
| `NxTextarea`, `NxSelect`                     | Styled `textarea` and `select`; use inside `Field` and spread the control props (added for Project Workspace V1)                                                                             |
| `NxInput`                                    | Styled `input`; use inside `Field`                                                                                                                                                           |
| `StatusBadge`                                | `tone` ok / attention / danger / info / neutral / unknown + required text. Use `unknown` for unverified state, never `neutral`.                                                              |
| `DataTable<Row>`                             | Required `caption`, `columns`, `rows`, `rowKey`, `empty`. Scrolls inside its own keyboard-focusable region; never widens the page.                                                           |
| `SearchFilter`                               | Labelled search field; the parent owns value and filtering                                                                                                                                   |
| `LoadingState` / `EmptyState` / `ErrorState` | Loading is `role="status"`, error is `role="alert"` with optional retry. Empty states say why and what to do.                                                                                |
| `ConfirmDialog`                              | Native `<dialog>`; modal, inert background, Escape cancels, focus returns to the opener, **Cancel is the initial focus**. Use `danger` for destructive actions.                              |

Rules for features:

1. Use roles, not hex. Add a role to `design.css` before adding a colour to a component.
2. Display **0** only for a confirmed zero. Otherwise show Unknown / Unavailable / Not connected /
   Not implemented (spec section 6, application-state integrity).
3. Mock and synthetic data must be labelled as such in the UI.
4. Components render and style; backend-owned business rules stay out of them.
5. Add motion only for a real state change and keep it under the motion tokens.

## Accessibility and verification actually performed

Run against the showcase in Chromium by `ui/design.spec.ts`:

- Text contrast, control boundary contrast and focus-ring contrast, from computed colours.
- axe-core with no violations at 390px and 1440px (including the validation error state) and
  with the dialog open.
- No horizontal overflow at 320, 390, 720, 820, 1024 and 1440px; also at 320px with a 16px minimum
  font setting, and at genuine 200% browser zoom (verified by `devicePixelRatio` and `innerWidth`).
- Keyboard: every control reached by Tab shows a 2px or wider focus ring; dialog focus, Escape and
  focus restore; busy button stays focusable.
- Reduced motion: spinner animation and transitions are removed; and the spinner does animate when
  motion is allowed.
- No request leaves the local origin (no CDN fonts), and the tokens are defined on `.nx-theme`, never on `:root`, so loading the stylesheet defines no custom property on the document root.

## Known limitations

- Chromium only (matches CI). No Firefox or WebKit, no OS-level Ctrl+ zoom, no screen reader run.
- Contrast was computed on the token colours and DOM colours; it was not audited against images or
  glows, because the foundation has none.
- Fonts are system fallbacks until an owner-approved self-hosting step.
- Tables do not yet support sorting, selection or pagination. Add those when a screen needs them.
- Only a dark theme exists. Light operational screens keep their existing theme until they migrate.

## Migration strategy

1. **Existing light screens (Tasks, Runs, Agents, Departments, shared shell):** leave unchanged.
   Migrate one screen per PR, wrapping it in `NxTheme` and replacing its local buttons, fields,
   tables and states with the shared ones. Each PR keeps that screen's existing browser tests
   passing unchanged, and adds a visual check. The shared header migrates last, since it affects
   every screen.
2. **Command Center (done, PRs #92 and #93):** it is built directly on these tokens and components,
   with no palette of its own. The token block in `design/design.css` also selects
   `.app-shell[data-view='command-center']`, so the page chrome around the screen reads the same
   palette, and its layout is scoped to `.ccx-*`. The earlier PR #31 design, which defined its own
   `.nexus` variables, was superseded and never merged.
3. **Order:** Project Workspace V1 first (new, no migration risk), then the Command Center (done),
   then Departments, Agents, Tasks, Runs, and last the shared header.

## Project Workspace V1

Project Workspace V1 is built from these components. See
[PROJECT_WORKSPACE_V1_FRONTEND.md](PROJECT_WORKSPACE_V1_FRONTEND.md) for routes, the API contract
as implemented, mutation and recovery behaviour, and limitations.

### Revisions made while building it

- **Token scope.** Tokens moved from `:root` to `.nx-theme`. The Projects screen is the first
  production consumer, so the stylesheet is now in the application bundle; scoping keeps it from
  defining anything on the document root. Every component still sits inside `NxTheme`.
- **`NxTextarea` and `NxSelect`** were added; the project form needs a multi-line objective and a
  priority choice.
- **`Panel.headingRef`** was added so a screen can move focus to its heading after in-app
  navigation.
- **Corrections to the earlier handoff:** projects have no department field and the project list
  has no task counts, so neither is shown. Verified error codes are `not_found`, `conflict`,
  `invalid_transition`, `invalid_input`, `limit`, `csrf_rejected`, `project_outcome_unknown` and
  `invalid_cursor`.
- **`PageHeader` and `PageContainer`** are not used in the application: the shell already renders
  the page's single `h1` and its own container, so the screen uses `Panel` (h2) and `h3`.
