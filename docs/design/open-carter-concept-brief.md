# Open Carter concept brief (throwaway concept screens)

Tool: Magic Patterns (primary) or v0 (fallback).
Goal: generate concept screens for a desktop app. This is not production code. The winning direction gets handed to a coding agent afterward.

## Product context

Electron + React + TypeScript desktop app ("Open Carter"). Window is roughly 1280 to 1440px wide and resizable. It is a desktop app, not a marketing site. No hero, no website nav or footer.

## Brand and tokens

- Base color neutral. Primary near-black (#18181b family). Follow the shadcn "new-york" convention, baseColor neutral, CSS variables.
- Use semantic tokens only: background, foreground, primary, muted, muted-foreground, border, ring, destructive. No raw hex in components.
- Type: Geist or Inter, weights 400/500/600/700. Spacing on a 4px scale. Corner radius about 0.5rem.
- Icons: lucide only, consistent stroke width, 16 or 20px.
- Both light and dark mode required.

## Screen 1: Home dashboard

- Layout: left sidebar nav plus a main area. Main area has a widgets row or grid, a task board (kanban columns with cards), and a pinned-chats list.
- Components: Sidebar, NavItem, WidgetCard, StatBlock, TaskBoard, TaskColumn, TaskCard, Badge, PinnedChatList, PinnedChatRow, Avatar, Button, IconButton, DropdownMenu, ScrollArea, Separator.
- Desktop behavior: fixed sidebar, independently scrollable columns, cards with hover elevation, a drag-handle affordance on task cards (visual only).

## Screen 2: Chat composer and session view

- Layout: session header (title, model selector, actions), scrollable message thread, sticky bottom composer.
- Components: SessionHeader, ModelSelector, MessageList, MessageBubble (user, assistant, tool), AttachmentChip, Composer, Textarea (auto-grow), SendButton, StopButton, TokenCounter, SuggestedPrompt, ScrollArea, Separator.
- Composer: multiline auto-grow input, attach button, send and stop states, a keyboard-hint row (for example "Enter to send, Shift+Enter for newline").

## States to show

Every interactive component: default, hover, focus-visible, disabled, selected or active. Plus empty (no widgets, no tasks, no chats, empty thread), loading (skeleton for widget, task list, message thread), and error (failed widget, failed message).

## Constraints

- Target stack is Tailwind CSS v4 and @base-ui/react. Treat generated Tailwind v3 or Radix-style classes as intent to be mapped, not literal.
- Animation via the motion library. Subtle fades and slides only, no bouncing.
- No emoji. No purple gradients, no gradient-mesh branding.
- No external image placeholders. Use neutral gray placeholders or generated UI only.
- Copy is terse and realistic product UI, not lorem ipsum.

## Deliverable

Two concept frames at 1440x900, light and dark, exported as code plus a shareable link. Mark as throwaway concept, not final.

## Handoff to code

Use Magic Patterns' Integration Skill so the coding agent maps the prototype onto the real codebase: hand-rolled buttons and inputs to Base UI primitives, raw hex to semantic tokens, Tailwind v3 to v4, framer-motion to motion, and no new icon or router dependencies.
