# Schedule Day Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the Schedule plan grouping with a navigable daily view that pairs the existing activity list with a Google Calendar-like day timeline.

**Architecture:** Keep data fetching and role decisions in the Schedule view, while moving schedule-specific UI into `components/schedule`. The daily view receives tasks and a selected UTC date, with a 30% list column and 70% calendar column. Existing protocol and order flows remain available in their tabs.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS v4, shadcn/ui, lucide-react.

**Spec:** User request for Health Schedule daily calendar and schedule component split.

## Global Constraints

- Preserve UTC mission dates and task times.
- Preserve the existing role-specific list behavior and protocol/order tabs.
- Remove only the status dot from the Schedule table status pills.
- Create all Schedule-specific components under `components/schedule`.

## Review Focus

- Navigating backward and forward must change only the selected day and keep tasks outside that day hidden.
- Tasks near midnight must remain on the correct UTC day.
- Empty days must show a useful empty state in both the list and timeline.
- Long task titles and statuses must not overflow the two-column layout.
- The 30/70 layout must collapse cleanly on small screens.

### Task 1: Add daily list/calendar components and wire Schedule

**Files:**
- Create: `components/schedule/schedule-day-view.tsx`
- Create: `components/schedule/schedule-day-list.tsx`
- Create: `components/schedule/schedule-calendar.tsx`
- Create: `components/schedule/schedule-protocol-card.tsx`
- Create: `components/schedule/schedule-order-form.tsx`
- Modify: `app/(app)/schedule/view.tsx`

**Interfaces:**
- `ScheduleDayView` receives `tasks`, `today`, `ops`, and a loading flag.
- `ScheduleDayList` and `ScheduleCalendar` receive the selected day's `Task[]` and selected UTC date.

- [ ] Move Schedule-specific protocol and order UI into the new folder.
- [ ] Implement date navigation and the 30/70 daily list/timeline layout.
- [ ] Remove the status dot from the Schedule table pills.
- [ ] Run lint, TypeScript, build, and diff checks.
