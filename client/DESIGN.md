# AI Meeting Operations Console Design System

## 0. Research Log

- Embedded refs: shortlisted Notion, Linear, and Vercel; picked the operational restraint of the neutral taste skill, with a compact command-center layout suited to an internal tool.
- Lazyweb: skipped — no external product research was necessary for this small internal console.
- Imagen drafts: skipped — the requested surface is a lightweight utility, not an image-led experience.

## 1. Atmosphere & Identity

This is a quiet maintenance console for operators who need confidence before they trigger a backend job. The signature is a warm paper-like canvas with a dark graphite command rail and one amber signal color: status and action are legible without turning the screen into a dashboard of noise.

## 2. Color

### Palette

| Role | Token | Value | Usage |
|------|-------|-------|-------|
| Surface/primary | `--surface-primary` | `#f4f1ea` | Page canvas |
| Surface/secondary | `--surface-secondary` | `#ebe7de` | Subtle sections |
| Surface/elevated | `--surface-elevated` | `#fffdf8` | Cards and panels |
| Rail/primary | `--rail-primary` | `#202321` | Header and command rail |
| Text/primary | `--text-primary` | `#202321` | Headings and body |
| Text/secondary | `--text-secondary` | `#6d716b` | Supporting copy |
| Text/inverse | `--text-inverse` | `#f8f5ed` | Rail text |
| Border/default | `--border-default` | `#d8d2c5` | Panel outlines |
| Border/strong | `--border-strong` | `#b8b1a3` | Focus and emphasis |
| Accent/primary | `--accent-primary` | `#c8793d` | Primary action and live signal |
| Accent/hover | `--accent-hover` | `#a85f2d` | Action hover |
| Status/success | `--status-success` | `#2f7d5a` | Healthy state |
| Status/warning | `--status-warning` | `#b26a28` | Attention state |
| Status/error | `--status-error` | `#b94a45` | Request failure |

### Rules

- Use tonal shifts and restrained borders for depth; no decorative gradients.
- Accent orange is reserved for the primary operation and small live indicators.
- Error color is paired with explicit text, never color alone.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Usage |
|-------|------|--------|-------------|-------|
| Display | `clamp(2.25rem, 5vw, 4rem)` | 700 | 1.05 | Page title |
| H1 | `2rem` | 700 | 1.15 | Major section |
| H2 | `1.375rem` | 700 | 1.3 | Panel heading |
| Body | `1rem` | 400 | 1.6 | Main copy |
| Body/sm | `0.875rem` | 400 | 1.5 | Supporting copy |
| Caption | `0.75rem` | 600 | 1.4 | Labels and metadata |

### Font Stack

- Primary: `"Avenir Next", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`
- Mono: `"SFMono-Regular", Consolas, "Liberation Mono", monospace`

## 4. Spacing & Layout

All spacing derives from a 4px base unit.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | `4px` | Icon-to-label |
| `--space-2` | `8px` | Compact groups |
| `--space-3` | `12px` | Field internals |
| `--space-4` | `16px` | Standard gaps |
| `--space-5` | `20px` | Panel rhythm |
| `--space-6` | `24px` | Card padding |
| `--space-8` | `32px` | Group separation |
| `--space-10` | `40px` | Major sections |
| `--space-12` | `48px` | Page breathing room |

- Max content width: `1180px`.
- Layout: top rail plus a responsive two-column workspace; the main panel carries the action, the side panel carries system context.
- Breakpoints: `640px`, `768px`, `1024px`.

## 5. Components

### Command Rail

- **Structure**: semantic header with product mark, environment label, and live connection indicator.
- **Variants**: desktop horizontal, mobile stacked.
- **Spacing**: `--space-4` to `--space-6`.
- **States**: healthy, attention, offline.
- **Accessibility**: text status accompanies the indicator; no information is conveyed by color alone.
- **Motion**: none except a subtle opacity change when status updates.
- **Layout**: shell header.

### Status Panel

- **Structure**: heading, status badge, key-value rows, refresh button.
- **Variants**: loading, healthy, error.
- **Spacing**: `--space-5` and `--space-6`.
- **States**: loading, success, error, stale.
- **Accessibility**: `aria-live="polite"` on result text and keyboard-visible refresh control.
- **Motion**: status dot uses opacity only; respects reduced motion.
- **Layout**: stacked card.

### Maintenance Panel

- **Structure**: explanatory copy, token field, primary trigger button, result notice.
- **Variants**: idle, submitting, success, error.
- **Spacing**: `--space-3` through `--space-6`.
- **States**: default, focus, disabled/loading, success, error.
- **Accessibility**: explicit label, password input semantics, button disabled while submitting, result announced politely.
- **Motion**: button press uses transform and opacity only.
- **Layout**: primary action card.

### Notice

- **Structure**: status marker, title, detail text.
- **Variants**: info, success, error.
- **Spacing**: `--space-3` and `--space-4`.
- **States**: visible and empty.
- **Accessibility**: `role="status"` for successful operations and `role="alert"` for failures.
- **Motion**: opacity entry only.
- **Layout**: inline feedback block.

## 6. Motion & Interaction

- Micro interactions: `120ms`, `ease-out`.
- Panel/status transitions: `220ms`, `ease-in-out`.
- Animate only `transform` and `opacity`.
- Every interactive control has hover, active, focus-visible, disabled, and loading treatment.
- `prefers-reduced-motion: reduce` disables non-essential transitions.

## 7. Depth & Surface

Strategy: mixed, using warm tonal shifts plus one subtle shadow for elevated cards.

- Cards use `--surface-elevated`, `1px solid var(--border-default)`, and `0 12px 30px rgba(32, 35, 33, 0.07)`.
- The page canvas and cards must remain visually distinct without heavy outlines.
- The dark rail is the only full-bleed high-contrast surface.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- WCAG 2.2 AA target: 4.5:1 body contrast and 3:1 large-text contrast.
- Full keyboard reachability, visible focus rings, semantic landmarks, and reduced-motion support.
- Primary content reflows to one readable column at 375px with no horizontal overflow.
- Maintenance token remains component state only; it must never be logged, persisted, or rendered back into the page.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|------|----------|--------------|--------------|
| No authenticated session persistence | `client/src/App.vue` | This endpoint intentionally uses an operator-supplied one-shot token. | Revisit only if backend adds a session-based maintenance flow. |
