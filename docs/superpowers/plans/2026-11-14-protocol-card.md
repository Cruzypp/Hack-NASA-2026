# Protocol Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a reusable `ProtocolCard` component in `components/shared` and render it at `/components/protocol-card`.

**Architecture:** Keep shadcn primitives in `components/ui`; place this ASTRA-specific domain component in `components/shared`. The card accepts a small typed data object so future pages can reuse the layout without copying the HTML. The route is a server component that renders a representative aerobic-exercise protocol.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS v4, `lucide-react`.

**Spec:** User-provided protocol-card HTML design.

## Global Constraints

- Preserve the existing App Router and route-group structure.
- Do not add dependencies; use installed `lucide-react` icons and existing Tailwind tokens/utilities.
- Keep shared domain components outside `components/ui`.
- The public route must be `/components/protocol-card`.

## Review Focus

- Mobile header wrapping must keep the title and status badge readable.
- Long checklist/reference text must wrap without horizontal overflow.
- The card must remain legible when optional reminder or approval metadata is absent.
- Icons must be decorative or paired with visible labels so the route remains accessible.
- The new route must compile under the repository's Next.js 16 App Router setup.

### Task 1: Build and showcase the shared protocol card

**Files:**
- Create: `components/shared/protocol-card.tsx`
- Create: `app/(app)/components/protocol-card/page.tsx`

**Interfaces:**
- Produces `ProtocolCardProps` with title, cadence, priority, version, status, schedule, completion criteria, reference, and approval fields.

- [ ] Implement the typed reusable card with the supplied visual hierarchy, responsive layout, and accessible labels.
- [ ] Render the aerobic exercise example from the supplied HTML at the requested route.
- [ ] Run TypeScript validation and the production build.

