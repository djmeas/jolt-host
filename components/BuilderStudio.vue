<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import {
  CHAT_MESSAGE_MAX_BYTES,
  useAiWorkspace,
  type PreviewSettings,
  type WorkspaceFile,
} from '~/composables/useAiWorkspace'
import type { UploadResult } from '~/composables/useResultStorage'
import ConversationPane from './builder/ConversationPane.vue'
import FilePane from './builder/FilePane.vue'
import PublishPane from './builder/PublishPane.vue'

/**
 * Builder Studio workbench.
 *
 * The workspace stays private: this shell only presents state, and generated
 * source is never executed or rendered as markup on the app origin. Preview
 * publishes through the server, which is the only path to a hosted URL.
 */
const props = defineProps<{ editSlug?: string | null }>()

type StudioView = 'conversation' | 'files' | 'publish'

const VIEWS: { id: StudioView; label: string }[] = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'files', label: 'Files' },
  { id: 'publish', label: 'Publish' },
]

const { data: siteConfig } = useFetch('/api/config')
const dataApiToggleAvailable = computed(
  () => siteConfig.value?.dataFeatureAvailable === true && siteConfig.value?.dataApiToggleEnabled !== false
)

const turnstileContainer = ref<HTMLElement | null>(null)
const {
  token: turnstileToken,
  isEnabled: turnstileEnabled,
  renderWidget,
  reset: resetTurnstile,
  cleanup: cleanupTurnstile,
} = useTurnstile()

const workspace = useAiWorkspace({
  turnstile: { isEnabled: turnstileEnabled, token: turnstileToken, reset: resetTurnstile },
})
const {
  state,
  target,
  transcript,
  loading,
  loaded,
  loadError,
  busy,
  errorCode,
  errorMessage,
  notice,
  publishedResult,
  openPath,
  openContent,
  openLoading,
  openError,
  load,
  sendMessage,
  openFile,
  closeFile,
  publishPreview,
  publishChanges,
  attach,
  restore,
  startNewSite,
} = workspace

watch(turnstileContainer, (element) => {
  if (element) renderWidget(element)
}, { flush: 'post' })
onUnmounted(() => cleanupTurnstile())
onMounted(() => {
  void load()
})

function setTurnstileContainer(el: Element | ComponentPublicInstance | null) {
  turnstileContainer.value = el instanceof HTMLElement ? el : null
}

/** `?edit=<slug>` only proposes an attachment; nothing happens without a click. */
const editSlug = computed(() => (typeof props.editSlug === 'string' && props.editSlug ? props.editSlug : null))
const attachPromptDismissed = ref(false)
const pendingAttach = computed(
  () => editSlug.value !== null && !attachPromptDismissed.value && target.value?.slug !== editSlug.value
)

const activeView = ref<StudioView>('conversation')
const publishOpen = ref(false)
const workbenchEl = ref<HTMLElement | null>(null)

async function focusPane(view: StudioView) {
  await nextTick()
  workbenchEl.value?.querySelector<HTMLElement>(`.pane-${view}`)?.focus()
}

/**
 * Reveal and focus a pane after a mutation. A focused pane that is still
 * `display:none` (narrow views) or parked behind the closed tablet drawer is
 * unreachable, so the layout state is opened first. These handlers only run
 * from browser interactions, which keeps the viewport probe out of setup.
 */
async function revealPane(view: StudioView) {
  if (window.matchMedia('(max-width: 899px)').matches) {
    activeView.value = view
  } else if (view === 'publish' && window.matchMedia('(max-width: 1199px)').matches) {
    publishOpen.value = true
  }
  await focusPane(view)
}

function selectView(view: StudioView) {
  activeView.value = view
  publishOpen.value = false
  void focusPane(view)
}

async function handleSend(text: string): Promise<boolean> {
  const sent = await sendMessage(text)
  if (sent) void revealPane('conversation')
  return sent
}

async function handleAttach() {
  if (!editSlug.value) return
  const attached = await attach(editSlug.value)
  if (attached) {
    attachPromptDismissed.value = true
    void revealPane('conversation')
  }
}

async function handlePreview(settings: PreviewSettings): Promise<UploadResult | null> {
  const result = await publishPreview(settings)
  if (result) void revealPane('publish')
  return result
}

async function handlePublishChanges(): Promise<boolean> {
  const published = await publishChanges()
  if (published) void revealPane('publish')
  return published
}

async function handleRestore(): Promise<boolean> {
  const restored = await restore()
  if (restored) void revealPane('publish')
  return restored
}

async function handleStartNewSite(): Promise<boolean> {
  const started = await startNewSite()
  if (started) {
    attachPromptDismissed.value = true
    void revealPane('conversation')
  }
  return started
}

function pickFile(file: WorkspaceFile) {
  void openFile(file)
}
</script>

<template>
  <div class="studio" :class="{ 'is-publish-open': publishOpen }">
    <header class="studio-bar">
      <div class="bar-left">
        <span class="mark">&lt;jolt⚡&gt;</span>
        <span class="bar-title">Builder</span>
        <span class="mode">{{ target ? `Editing ${target.slug}` : 'New site' }}</span>
        <span class="draft-state">Private draft — not live</span>
      </div>
      <div class="bar-right">
        <a
          v-if="target?.url"
          class="bar-link"
          :href="target.url"
          target="_blank"
          rel="noopener noreferrer"
        >{{ target.url }}</a>
        <button
          type="button"
          class="publish-toggle"
          :aria-expanded="publishOpen"
          aria-controls="studio-publish-pane"
          @click="publishOpen = !publishOpen"
        >{{ publishOpen ? 'Close publish' : 'Publish' }}</button>
        <NuxtLink class="bar-link" to="/dashboard">Dashboard</NuxtLink>
      </div>
    </header>

    <div v-if="loadError || errorMessage" class="studio-alert" role="alert">
      <span>{{ loadError || errorMessage }}</span>
      <button v-if="loadError" type="button" class="btn-inline" @click="load">Retry</button>
      <button
        v-else-if="errorCode === 'workspace_conflict' || errorCode === 'workspace_busy'"
        type="button"
        class="btn-inline"
        @click="load"
      >Refresh workspace</button>
    </div>

    <div v-if="pendingAttach" class="attach-banner" role="region" aria-label="Attach an existing site">
      <h2 class="attach-title">Attach an existing site</h2>
      <p class="attach-copy">
        Attaching <strong>{{ editSlug }}</strong> replaces the current draft files and chat session with
        that site's live content. The site is not changed until you choose “Publish changes”.
      </p>
      <div class="attach-actions">
        <button type="button" class="btn" :disabled="busy" @click="handleAttach">
          {{ busy ? 'Attaching…' : `Attach ${editSlug}` }}
        </button>
        <button type="button" class="btn-quiet" :disabled="busy" @click="attachPromptDismissed = true">
          Keep current draft
        </button>
      </div>
    </div>

    <nav class="view-switcher" aria-label="Workspace views">
      <button
        v-for="view in VIEWS"
        :key="view.id"
        type="button"
        class="view-btn"
        :class="{ active: activeView === view.id }"
        :aria-pressed="activeView === view.id"
        @click="selectView(view.id)"
      >{{ view.label }}</button>
    </nav>

    <div ref="workbenchEl" class="workbench" :data-view="activeView">
      <section class="pane pane-conversation" tabindex="-1" aria-label="Conversation">
        <ConversationPane
          :messages="transcript"
          :busy="busy"
          :notice="notice"
          :max-bytes="CHAT_MESSAGE_MAX_BYTES"
          :loading="loading"
          :loaded="loaded"
          :send="handleSend"
        />
      </section>

      <section class="pane pane-files" tabindex="-1" aria-label="Workspace files and source">
        <FilePane
          :files="state?.files ?? []"
          :editable-files="state?.editable_files ?? 0"
          :opaque-files="state?.opaque_files ?? 0"
          :editable-bytes="state?.editable_bytes ?? 0"
          :open-path="openPath"
          :open-content="openContent"
          :open-loading="openLoading"
          :open-error="openError"
          :busy="busy"
          :open="pickFile"
          :close="closeFile"
        />
      </section>

      <section id="studio-publish-pane" class="pane pane-publish" tabindex="-1" aria-label="Review and publish">
        <button type="button" class="drawer-close" @click="publishOpen = false">Close publish</button>
        <PublishPane
          :target="target"
          :file-count="state?.files?.length ?? 0"
          :editable-bytes="state?.editable_bytes ?? 0"
          :restore-available="state?.restore_available ?? false"
          :busy="busy"
          :turnstile-enabled="turnstileEnabled"
          :turnstile-token="turnstileToken"
          :data-api-toggle-available="dataApiToggleAvailable"
          :published="publishedResult"
          :set-turnstile-container="setTurnstileContainer"
          :preview="handlePreview"
          :publish-changes="handlePublishChanges"
          :restore="handleRestore"
          :start-new-site="handleStartNewSite"
        />
      </section>
    </div>

    <div v-if="publishOpen" class="drawer-backdrop" @click="publishOpen = false" />
  </div>
</template>

<style scoped>
.studio {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: #0f0f12;
  color: #f1f1f4;
  text-align: left;
}
.studio-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid #30303a;
  background: #14141a;
}
.bar-left,
.bar-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.mark {
  font-family: 'Contrail One', sans-serif;
  font-size: 1.05rem;
  line-height: 1;
  color: #f1f1f4;
}
.bar-title {
  font-size: 0.9rem;
  font-weight: 600;
}
.mode {
  font-size: 0.78rem;
  padding: 0.15rem 0.55rem;
  border: 1px solid #30303a;
  border-radius: 999px;
  color: #e4e4e7;
}
.draft-state {
  font-size: 0.75rem;
  color: #a1a1aa;
}
.bar-link {
  font-size: 0.78rem;
  color: #a78bfa;
  text-decoration: none;
  overflow-wrap: anywhere;
}
.bar-link:hover {
  text-decoration: underline;
}
.publish-toggle {
  display: none;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  padding: 0.35rem 0.7rem;
  min-height: 34px;
  border-radius: 8px;
  border: 1px solid #fde047;
  background: rgba(253, 224, 71, 0.12);
  color: #fde047;
  cursor: pointer;
}
.studio-alert {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid rgba(248, 113, 113, 0.4);
  background: rgba(248, 113, 113, 0.1);
  font-size: 0.8rem;
  color: #fca5a5;
}
.btn-inline {
  font: inherit;
  font-size: 0.78rem;
  color: #fca5a5;
  background: none;
  border: 1px solid rgba(248, 113, 113, 0.5);
  border-radius: 6px;
  padding: 0.3rem 0.6rem;
  cursor: pointer;
}
.attach-banner {
  padding: 0.85rem 1rem;
  border-bottom: 1px solid #30303a;
  background: #181820;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.attach-title {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 600;
}
.attach-copy {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.55;
  color: #e4e4e7;
  max-width: 72ch;
}
.attach-actions {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.btn,
.btn-quiet {
  font: inherit;
  font-size: 0.82rem;
  font-weight: 500;
  padding: 0.5rem 0.9rem;
  min-height: 40px;
  border-radius: 8px;
  cursor: pointer;
}
.btn {
  border: 1px solid #a78bfa;
  background: rgba(167, 139, 250, 0.18);
  color: #ece7ff;
}
.btn-quiet {
  border: 1px solid #30303a;
  background: transparent;
  color: #e4e4e7;
}
.btn:disabled,
.btn-quiet:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.workbench {
  flex: 1;
  min-height: 0;
  display: flex;
}
.pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pane:focus {
  outline: 2px solid #a78bfa;
  outline-offset: -2px;
}
.pane-conversation {
  flex: 0 0 24rem;
  max-width: 26rem;
  border-right: 1px solid #30303a;
}
.pane-files {
  flex: 1 1 auto;
}
.pane-publish {
  flex: 0 0 20rem;
  max-width: 22rem;
  border-left: 1px solid #30303a;
}
.drawer-close,
.drawer-backdrop {
  display: none;
}
.view-switcher {
  display: none;
  gap: 0.4rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid #30303a;
  background: #14141a;
}
.view-btn {
  flex: 1 1 0;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 500;
  padding: 0.45rem 0.6rem;
  min-height: 40px;
  border-radius: 8px;
  border: 1px solid #30303a;
  background: transparent;
  color: #a1a1aa;
  cursor: pointer;
}
.view-btn.active {
  border-color: #a78bfa;
  background: rgba(167, 139, 250, 0.16);
  color: #f1f1f4;
}
.btn:focus-visible,
.btn-quiet:focus-visible,
.btn-inline:focus-visible,
.publish-toggle:focus-visible,
.view-btn:focus-visible,
.drawer-close:focus-visible,
.bar-link:focus-visible {
  outline: 2px solid #a78bfa;
  outline-offset: 2px;
}

/* Tablet / small desktop: the publish rail collapses into a right-side drawer. */
@media (min-width: 900px) and (max-width: 1199px) {
  .publish-toggle {
    display: inline-flex;
    align-items: center;
  }
  .pane-conversation {
    flex: 0 0 22rem;
  }
  .pane-publish {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(22rem, 92vw);
    max-width: none;
    flex: 0 0 auto;
    z-index: 40;
    background: #181820;
    border-left: 1px solid #30303a;
    transform: translateX(100%);
    transition: transform 0.18s ease-out;
  }
  .studio.is-publish-open .pane-publish {
    transform: none;
  }
  .drawer-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font: inherit;
    font-size: 0.75rem;
    min-height: 36px;
    margin: 0.5rem 1rem 0;
    border: 1px solid #30303a;
    border-radius: 8px;
    background: transparent;
    color: #e4e4e7;
    cursor: pointer;
  }
  .drawer-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 30;
    background: rgba(0, 0, 0, 0.5);
  }
}

/* Narrow: one accessible pane at a time with an explicit view switcher. */
@media (max-width: 899px) {
  .workbench {
    flex-direction: column;
  }
  .view-switcher {
    display: flex;
    order: -1;
  }
  .pane {
    display: none;
    flex: 1 1 auto;
    width: 100%;
    max-width: none;
    border: 0;
  }
  .workbench[data-view='conversation'] .pane-conversation,
  .workbench[data-view='files'] .pane-files,
  .workbench[data-view='publish'] .pane-publish {
    display: flex;
  }
  .drawer-close {
    display: none;
  }
}

/* Phone: the switcher docks above the browser keyboard region. */
@media (max-width: 640px) {
  .studio-bar {
    padding: 0.5rem 0.75rem;
  }
  .draft-state {
    width: 100%;
  }
  .view-switcher {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 50;
    padding: 0.4rem 0.6rem calc(0.4rem + env(safe-area-inset-bottom));
    border-top: 1px solid #30303a;
    border-bottom: 0;
  }
  .workbench {
    padding-bottom: calc(3.5rem + env(safe-area-inset-bottom));
  }
  .view-btn,
  .btn,
  .btn-quiet {
    min-height: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pane-publish {
    transition: none;
  }
}
</style>
