# Plan 002: Move AI Builder into a full-screen Builder Studio

> **Executor instructions**: Follow this plan step by step. Keep the existing AI workspace, provider, publishing, ownership, and isolated-origin contracts intact. This is a UI and route cutover, not a new generation protocol. Run every verification command and complete the browser smoke matrix before marking the plan done. If a STOP condition occurs, stop and report rather than improvising.
>
> **Drift check (run first)**: `git diff --stat c18a546..HEAD -- app.vue pages/index.vue pages/build.vue pages/dashboard/index.vue components/AiBuilder.vue components/BuilderStudio.vue components/builder composables README.md docs/how-to.md`
>
> The plan was written against `c18a546`. If an in-scope file has changed, compare the live code with the Current state section before proceeding. Treat a material mismatch as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L (multi-day UI cutover and browser verification)
- **Risk**: MED
- **Depends on**: none; the shipped AI workspace API is the foundation
- **Category**: direction / UX
- **Planned at**: commit `c18a546`, 2026-10-02

## Why this matters

The shipped builder is a capable private workspace but lives inside the landing page upload card. Its conversation, file inspection, attachment state, and publication controls compete for a narrow form-sized area, which makes iterative site work feel like an incidental upload option rather than a dedicated tool.

The target is a route-owned Builder Studio: a persistent workbench for conversation, source inspection, and deliberate publication. The change must not weaken the security model: generated HTML is untrusted, private drafts are never served, and **Preview** remains an explicit real publication rather than a browser-executed draft.

## Product decision locked by this plan

1. **Route**: `/build` is the only Builder Studio route. `/build?edit=<slug>` opens the same studio with an explicit attach confirmation. The `edit` query identifies a target only; it never grants permission and never attaches automatically.
2. **Cutover**: the home page's Build control becomes navigation to `/build`; it no longer mounts the builder inside the upload box. Dashboard links move from `/?tab=build` and `/?tab=build&edit=…` to `/build` and `/build?edit=…`. Do not retain the old query route as an alias.
3. **No unsafe live draft preview**: never render workspace HTML with `v-html`, `srcdoc`, Blob URLs, or an app-origin iframe. The visual-review action remains **Preview & publish** for a new site or **Publish changes** for an attached site. After a successful new-site publication, stay in Studio and show the isolated hosted URL plus a link to the normal result page; do not force navigation away from the workspace.
4. **No manual source editing in this release**: source remains an inspectable, read-only workspace view. The model remains the only writer of editable files. This avoids inventing an unreviewed write API and keeps the model-manifest/immutable-generation invariant intact.
5. **No backend API or database change**: reuse the current `/api/ai/**` and AI-workspace replacement APIs exactly. The UI remains responsible only for presentation, client state, and existing request bodies.

## Design direction: Jolt Builder Workbench

The Studio should look like a focused build surface, not a larger version of the existing upload card or a collection of floating SaaS cards.

- **Signature structure**: one edge-to-edge workbench with structural pane dividers. A compact studio bar identifies mode and target; the workspace itself is the visual hierarchy.
- **Palette**: retain the product's graphite base rather than introduce a second theme: canvas `#0f0f12`, raised workspace `#181820`, divider `#30303a`, primary text `#f1f1f4`, muted text `#a1a1aa`, Jolt violet `#a78bfa`, and Jolt amber `#fde047` for the irreversible publish action. Use red only for errors. No decorative gradients or uniform shadowed cards.
- **Type**: use the existing UI sans face for controls/messages, the existing Jolt brand face only for the mark, and `ui-monospace` only for file paths/source. Keep labels sentence case; do not add all-caps chrome.
- **Desktop layout (>= 1200px)**:

  ```text
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ <jolt⚡> Builder   New site | Editing <slug>   private draft   Dashboard  │
  ├───────────────────────┬──────────────────────────────┬────────────────────┤
  │ Conversation          │ Files + source inspector     │ Review & publish   │
  │ messages              │ file tree | read-only source │ target/status      │
  │                       │                               │ source limits      │
  │ sticky composer       │                               │ publish actions    │
  └───────────────────────┴──────────────────────────────┴────────────────────┘
  ```

  The conversation column is roughly 22–26rem; the publish rail is 19–22rem; the center pane takes the remaining width. The composer stays visible at the bottom of the conversation pane. File selection stays visible in the source inspector header.
- **Responsive behavior**: below 1200px, collapse the publish rail into a right-side drawer or a top-level "Publish" workspace view; below 900px, expose three explicit views—Conversation, Files, Publish—without horizontal scrolling; below 640px, use a bottom view switcher, preserve the composer above the browser keyboard, and make every action 44px minimum touch height.
- **Motion and accessibility**: no ambient animations. Give focus a strong violet outline, use `aria-live="polite"` for model progress/summaries, keep explicit text for busy/error states, respect reduced motion, and ensure the pane/view switcher is fully keyboard navigable.

## Current state

### Existing route and entry points

- `pages/index.vue:11-40` defines `LandingTab`, reads `?tab=build`, and mounts the builder only when the upload-card tab is selected.

  ```ts
  type LandingTab = 'upload' | 'build'
  const activeTab = ref<LandingTab>(route.query.tab === 'build' && aiBuilderAvailable.value ? 'build' : 'upload')
  const editSlug = computed(() => (typeof route.query.edit === 'string' && route.query.edit ? route.query.edit : null))
  ```

- `pages/index.vue:285-318` renders the Build tab and `<AiBuilder v-else :edit-slug="editSlug" />` inside `.box`, the constrained landing-page upload card.
- `pages/dashboard/index.vue:495` links to `/?tab=build`; `pages/dashboard/index.vue:692-698` links eligible rows to `/?tab=build&edit=<slug>`.
- `app.vue:4-6,91-94` treats only `/previewer` and `/editor` as full-width and always renders the normal navbar/footer around page content. Studio needs its own compact header, a full-width main area, and no duplicate global chrome/footer.

### Existing workspace behavior to preserve

- `components/AiBuilder.vue:15-43` owns typed workspace state: revision, editable/opaque file inventory, target metadata, restore availability, and the last transcript messages.
- `components/AiBuilder.vue:199-248` loads `GET /api/ai/files` and sends `{ message, revision }` to `POST /api/ai/chat`; it disables duplicate mutations and translates documented machine error codes to actionable UI messages.
- `components/AiBuilder.vue:304-321` requires an explicit Attach click for `?edit=<slug>` and warns that attach replaces the current draft/session.
- `components/AiBuilder.vue:269-301` publishes a new-site preview through `POST /api/ai/preview`; today it saves the result then routes to `/result/<slug>`. This plan changes only that post-success navigation: preserve the result in session storage, stay in Studio, and show links.
- `components/AiBuilder.vue:329-351` publishes an attached workspace through `PUT /api/uploads/<slug>/content` with `ai_workspace_revision`; it preserves the target slug/URL/settings and already remains on the current page. Keep this exact request and conflict behavior.
- `components/AiBuilder.vue:353-387` implements explicit local restore and start-new-site actions. Keep their confirmation copy and server authority.

### Security and product constraints

- `docs/plans/vibe-code-site-builder.md:52-58` locks the builder to one validated manifest per model call, a private per-user workspace, and separate-origin publication. It explicitly prohibits a server-side agent runtime and mandates existing-upload editing with opaque assets preserved.
- `docs/plans/vibe-code-site-builder.md:196-204` specifies full-file `add`/`update`/`delete` manifest operations, carries untouched files forward, and sends every editable workspace file to the model as current source of truth. The Studio must accurately describe this as a private draft; it must not claim line-level patches or a private executable preview.
- `components/AiBuilder.vue:5-12` records the current safe rendering boundary: responses and source use Vue interpolation/JSON; publishing is the only way to obtain a hosted site.
- Existing backend tests already cover workspace mutation, manifest validation, attach/restore/publish guards, and API ownership. This UI plan must not change their contracts.

### Test and style conventions

- Commands in `package.json:5-15`: `npm run build`, `npm run test:unit`, `npm run test:integration`, and `npm run test:composables`.
- `vitest.composables.config.ts:1-12` runs `composables/**/*.test.ts` in Nuxt with `happy-dom`. `composables/useResultStorage.test.ts` is the current narrow composable-test example.
- There is no component-test convention. Do not add brittle source-text or router-wiring tests merely to assert that a button points at `/build`; prove route/layout behavior with browser smoke tests.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift check | `git diff --stat c18a546..HEAD -- app.vue pages/index.vue pages/build.vue pages/dashboard/index.vue components/AiBuilder.vue components/BuilderStudio.vue components/builder composables README.md docs/how-to.md` | Review any changed in-scope file before editing. |
| Server suite | `npm run test:unit` | Exit 0; all server test files pass. |
| Composable suite | `npm run test:composables` | Exit 0; all composable test files pass. |
| Integration suite | `npm run test:integration` | Exit 0; all integration tests pass. |
| Production build | `npm run build` | Exit 0 and copied public assets. |
| Local UX smoke | `npm run dev` | Studio route renders on the emitted local origin. |

## Scope

**In scope**

- `app.vue` — add a studio-specific full-width/chrome decision without affecting existing `/editor` or `/previewer` behavior.
- `pages/build.vue` (new) — access gate, `/build?edit=<slug>` route parsing, Studio mount, page metadata.
- `pages/index.vue` — remove embedded builder state/template/styles and turn the visible Build choice into navigation to `/build`.
- `pages/dashboard/index.vue` — migrate general and per-site Builder links to `/build`.
- `components/AiBuilder.vue` (remove) — avoid retaining two divergent builder UIs.
- `components/BuilderStudio.vue` (new) and `components/builder/*.vue` (new) — full-screen shell and the three presentation panes.
- `composables/useAiWorkspace.ts` (new; add a test only for extracted pure state/error helpers with meaningful behavior) — move the existing fetch/mutation/revision logic out of presentation.
- `README.md` and `docs/how-to.md` — replace references to an embedded home-page Build tab/query route with the Builder Studio route and correct Preview wording.

**Out of scope**

- All `server/api/ai/**`, `server/utils/ai-*`, database, upload, hosted-site, provider, origin, or rate-limit changes.
- BYOK, provider selection, manual source editing, diff/patch APIs, live draft execution, Blob URLs, `srcdoc`, app-origin iframes, or a separate preview-serving service.
- Any automatic publication, automatic attach, automatic re-send/retry of paid turns, multi-generation undo, or a browser history/versioning system.
- Changes to ordinary upload, paste, editor, dashboard list semantics, or hosted URL/asset isolation.

## Git workflow

- Create a fresh feature branch from the current `feature/ai-builder` head; use the repository's conventional commit style, e.g. `feat: add AI-assisted site builder` and `fix: support OpenCode Go chat routing`.
- Commit logical units (state extraction, Studio route/UI, docs/tests). Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Extract the existing workspace client state without changing behavior

Create `composables/useAiWorkspace.ts` by moving the typed workspace state, guarded fetch/mutation calls, revision handling, error parsing, friendly messages, and Turnstile-aware publish/attach/restore/reset behavior out of `components/AiBuilder.vue`.

- Preserve every existing request URL, HTTP method, request body, and error code mapping.
- Preserve the one in-flight `busy` guard and never automatically retry/re-send a paid chat request.
- Expose only cohesive state/actions needed by the Studio: workspace state, selected source file/content, transcript, `busy`, feedback, `load`, `sendMessage`, `attach`, `publishPreview`, `publishChanges`, `restore`, and `startNewSite`.
- Keep route parsing and visual open/closed panel state out of the composable.
- Change new-site preview success to retain the returned `UploadResult` for the caller after `saveResult`; do not navigate inside the composable. The Studio will render an explicit "Open published site" and "Open result details" success state.
- Add a small `composables/useAiWorkspace.test.ts` only for behavior that can regress independent of the template: documented error-code wording, byte-bound handling, and a successful preview result remaining available without router navigation. Mock only the request boundary; do not test template forwarding.

**Verify**: `npm run test:composables` → exit 0 with the new behavior tests passing; `npm run test:unit` → exit 0.

### Step 2: Build the Studio route and access gate before removing the old UI

Create `pages/build.vue`.

- Fetch `/api/config` and refresh the registered-user session following the existing `pages/index.vue:20-26` pattern.
- Render a full-page access state for: signed out, Build Mode disabled, and provider unavailable. Use the current exact, friendly vocabulary; include existing login/register links where available. Do not silently redirect to the home page.
- Parse only a nonempty string `edit` query as a proposed attachment. Pass it to `<BuilderStudio>`. Never fetch, attach, or publish based on query parsing alone.
- Set page title/description to Builder-specific values and ensure loading states do not flash the upload card.
- Add a Studio mode to `app.vue`: full-width main, no generic navbar/footer while on `/build`; `BuilderStudio` owns the replacement compact studio bar. Keep existing routes visually unchanged.

**Verify**: `npm run build` → exit 0. Browser smoke: direct `/build`, `/build?edit=<owned-slug>`, and `/build?edit=<foreign-or-invalid-slug>` render the expected gate/confirmation rather than performing a mutation.

### Step 3: Implement the desktop workbench with explicit, safe vocabulary

Create `components/BuilderStudio.vue` as the orchestration/layout component, with small presentational children only where they remove a real concern:

- `components/builder/ConversationPane.vue` — transcript, busy status, sticky composer, keyboard behavior (`Cmd/Ctrl+Enter` sends; Enter inserts a newline), error/summary feedback.
- `components/builder/FilePane.vue` — editable/opaque file tree, byte/count summary, selected read-only source display. Source is rendered as escaped text only; no HTML parsing, syntax renderer that injects markup, or edit textarea.
- `components/builder/PublishPane.vue` — workspace target/mode, source cap summary, new-site settings and Preview & publish action, attached-site Publish changes / Restore locally / Start new actions. Keep confirmations explicit.

`BuilderStudio.vue` owns the route target, calls `useAiWorkspace`, chooses the selected file, and renders this desktop structure:

- **Studio bar**: Jolt mark, `Builder`, `New site` or `Editing <slug>`, a plain `Private draft — not live` state, dashboard exit link, and current hosted-target link only when one exists.
- **Conversation pane**: current transcript, clear no-message invitation, send status, and sticky composer. Show the returned model summary as a change event, not as a claim that a site was safely previewed.
- **Source pane**: contextual file tree plus a read-only source inspector. Show opaque assets as retained assets, never as editable source. Empty state says the workspace is private and asks the user to describe the first site.
- **Publish pane**: clearly distinguish `Preview & publish a new site` from `Publish changes to <slug>`. After new preview publication, keep the Studio mounted and show the hosted isolated URL plus `Open site` (new tab) and `View result details`. Do not add an iframe.
- **Attach flow**: keep the existing confirmation copy visible at the top of the workbench until the user chooses Attach or Keep current draft.

Do not create generic card grids. Use pane separators, one strong amber publish action, violet focus/selection states, and restrained surfaces defined in the design direction above.

**Verify**: `npm run build` → exit 0. Browser smoke at >= 1440px: all three panes visible without nested page scrolling; source selection updates the inspector; the composer remains visible while transcript scrolls; keyboard focus reaches every control in a sensible order.

### Step 4: Add responsive workspace views and preserve publication semantics

Implement CSS with structural breakpoints, not browser UA sniffing:

- At 1200px collapse the publish rail to a clearly labelled view/drawer; retain source and conversation without horizontal overflow.
- At 900px use an accessible single-active-pane switcher labelled Conversation, Files, Publish. Preserve pending composer text and selected file when changing views.
- At 640px switch to a bottom view switcher; do not obscure the composer or primary publish action under safe-area/browser keyboard regions.
- Preserve focus after a view switch and after each successful mutation. Use existing errors/actions when a revision conflict, busy state, rate limit, attachment denial, or publication failure occurs.
- Ensure Publish is never enabled during a busy mutation, and that attached/new mode never shows the other mode's controls.

**Verify**: browser device smoke at 1280×800, 900×800, and 390×844; no horizontal scroll; no clipped or unreachable composer/publish control; reduced-motion setting introduces no essential hidden transition.

### Step 5: Cut over entry points and delete the embedded builder

After `/build` passes the route and UI smoke:

- In `pages/index.vue`, remove `LandingTab`, Build query preselection/watchers, `editSlug`, and the in-card `<AiBuilder>` template. Replace the Build choice with a normal navigation control to `/build`; do not retain `role="tab"` semantics for a navigation action.
- Preserve ordinary Upload behavior, Turnstile lifecycle, upload form, minimal landing behavior, and home-page styling.
- In `pages/dashboard/index.vue`, update both links to `/build` and `/build?edit=${encodeURIComponent(u.slug)}`. Retain `aiBuilderAvailable`/`ai_editable` visibility conditions.
- Remove `components/AiBuilder.vue` only after no source imports/references it.
- Update `README.md:39,124,146` and `docs/how-to.md:47,58,70` to describe Builder Studio, the direct routes, explicit attach, and the fact that new-site preview is a publication that keeps the user in Studio.

**Verify**: `grep -R "tab=build\|AiBuilder" pages components README.md docs` → no live code/docs references. `npm run build` → exit 0.

### Step 6: Run full verification and document the safety boundary

Run all automated suites with no dev watcher running. Then run the browser scenarios below against a local provider/configured account.

**Verify**:

```bash
npm run test:unit
npm run test:composables
npm run test:integration
npm run build
git diff --check
```

All commands exit 0.

## Browser smoke matrix

1. **New site, desktop**: signed-in Build-Mode user clicks home Build control → `/build`; no upload card survives. Send a request, inspect generated source, publish a preview, remain in Studio, and open the hosted URL in a separate tab.
2. **Existing site**: Dashboard → Edit with AI → `/build?edit=<slug>` → explicit Attach → modify → Publish changes. Verify same hosted URL and no new dashboard row. Restore locally, verify hosted bytes remain unchanged until an explicit Publish.
3. **Access states**: signed-out, Build Mode disabled, and provider unavailable each show a focused Studio gate and make no workspace mutation.
4. **Safety**: verify there is no app-origin iframe, `srcdoc`, `v-html`, or Blob URL used for draft source. Browser DevTools must show workspace source fetched only from `/api/ai/files/...` as JSON.
5. **Responsive**: complete the three breakpoint checks in Step 4; test tab order, visible focus, and `Cmd/Ctrl+Enter` send behavior.

## Done criteria

- [ ] `/build` is the sole Builder UI route; `/build?edit=<slug>` requires explicit attachment.
- [ ] Home and dashboard builder controls all target `/build`; no `?tab=build` or `AiBuilder` references remain.
- [ ] The desktop Studio presents conversation, files/source, and publication without the landing upload-card constraint.
- [ ] Mobile/tablet use explicit accessible workspace views with no horizontal overflow or hidden primary action.
- [ ] New preview keeps the user in Studio and exposes only isolated hosted/result links; drafts never execute on the app origin.
- [ ] Existing server API request shapes, revisions, guards, provider calls, and publication behavior remain unchanged.
- [ ] `npm run test:unit`, `npm run test:composables`, `npm run test:integration`, `npm run build`, and `git diff --check` all exit 0.
- [ ] `plans/README.md` marks plan 002 `DONE` only after the browser smoke matrix passes.

## STOP conditions

Stop and report rather than improvise if any of these are true:

- The executor discovers that live visual preview is a hard product requirement before publication. That needs a separate isolated preview-origin/capability design; do not use `srcdoc`, Blob URLs, or app-origin iframe shortcuts.
- Moving request logic changes any `/api/ai/**` request shape, removes an existing busy/revision/Turnstile guard, or requires a backend API change.
- The UI needs manual source writes to meet acceptance. That requires a separate, authorization/revision/validation plan.
- A page/component test framework is introduced solely to test route links, component prop forwarding, or copied API calls.
- Any in-scope current-state excerpt differs materially from the live code and the difference affects access, publishing, isolated-origin, or workspace behavior.

## Maintenance notes

- The Studio's safety model depends on private workspace files never being executable on the app origin. A future interactive preview requires a security-reviewed isolated serving path, not a client-only rendering shortcut.
- Keep all provider, ownership, revision, and capacity logic server-side. The composable must reflect server state rather than duplicate it.
- The user-visible distinction between **private draft**, **Preview & publish a new site**, and **Publish changes to this existing site** is review-critical. Do not collapse those actions into a vague `Publish` button.
- Deferred deliberately: manual code editing, visual diffing, multi-generation undo/history, persistent preview history, and streaming model output. Each adds state or security semantics beyond this route/UI cutover.
