<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import type { UploadResult } from '~/composables/useResultStorage'
import type { PreviewSettings, WorkspaceTarget } from '~/composables/useAiWorkspace'

/**
 * Publish pane: the only place a draft becomes live.
 *
 * A new-site **Preview & publish** creates a real owned upload on the isolated
 * hosted origin, and the attached-site **Publish changes** replaces the same
 * URL and settings. Nothing here renders draft HTML on the app origin.
 */
const props = defineProps<{
  target: WorkspaceTarget | null
  fileCount: number
  editableBytes: number
  restoreAvailable: boolean
  busy: boolean
  turnstileEnabled: boolean
  turnstileToken: string | null
  dataApiToggleAvailable: boolean
  published: UploadResult | null
  setTurnstileContainer: (el: Element | ComponentPublicInstance | null) => void
  preview: (settings: PreviewSettings) => Promise<UploadResult | null>
  publishChanges: () => Promise<boolean>
  restore: () => Promise<boolean>
  startNewSite: () => Promise<boolean>
}>()

const previewTitle = ref('')
const previewExpiration = ref('1h')
const previewPassword = ref('')
const previewEnableData = ref(false)
const restoreConfirming = ref(false)
const resetConfirming = ref(false)

const expirationOptions = [
  { value: '1h', label: '1 hour' },
  { value: '8h', label: '8 hours' },
  { value: '1d', label: '1 day' },
  { value: '3d', label: '3 days' },
  { value: '1w', label: '1 week' },
] as const

const hasFiles = computed(() => props.fileCount > 0)
const canSubmit = computed(
  () => hasFiles.value && !props.busy && (!props.turnstileEnabled || Boolean(props.turnstileToken))
)

async function submitPreview() {
  await props.preview({
    title: previewTitle.value,
    expiration: previewExpiration.value,
    password: previewPassword.value,
    enableData: previewEnableData.value,
  })
}

async function submitChanges() {
  await props.publishChanges()
}

async function confirmRestore() {
  const restored = await props.restore()
  if (restored) restoreConfirming.value = false
}

async function confirmReset() {
  const started = await props.startNewSite()
  if (started) {
    resetConfirming.value = false
    restoreConfirming.value = false
  }
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}
</script>

<template>
  <div class="publish">
    <div class="pane-head">
      <h2 class="pane-title">Review &amp; publish</h2>
    </div>

    <div class="body">
      <dl class="facts">
        <div class="fact">
          <dt>Mode</dt>
          <dd>{{ target ? `Editing ${target.slug}` : 'New site' }}</dd>
        </div>
        <div class="fact">
          <dt>State</dt>
          <dd>Private draft — not live</dd>
        </div>
        <div class="fact">
          <dt>Draft size</dt>
          <dd>{{ fileCount }} text file{{ fileCount === 1 ? '' : 's' }} · {{ bytesLabel(editableBytes) }}</dd>
        </div>
        <div class="fact">
          <dt>Limits</dt>
          <dd>50 files · 1 MiB per file · 5 MiB total</dd>
        </div>
        <div v-if="target" class="fact">
          <dt>Target</dt>
          <dd>
            <a v-if="target.url" :href="target.url" target="_blank" rel="noopener noreferrer">{{ target.url }}</a>
            <span v-else>{{ target.slug }}</span>
          </dd>
        </div>
      </dl>

      <section v-if="!target" class="block">
        <h3 class="block-title">Preview &amp; publish a new site</h3>
        <p class="hint">
          This packages the current draft as a brand-new live site you own, served from the isolated
          hosted origin. It does not attach this workspace to that site, so you can keep iterating and
          publish again.
        </p>

        <div class="field">
          <label class="label" for="studio-title">Title (optional)</label>
          <input
            id="studio-title"
            v-model="previewTitle"
            class="input"
            type="text"
            maxlength="100"
            :disabled="busy"
            placeholder="My AI site"
          />
        </div>
        <div class="field">
          <label class="label" for="studio-expiration">Expiration</label>
          <select id="studio-expiration" v-model="previewExpiration" class="input" :disabled="busy">
            <option v-for="opt in expirationOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>
        <div class="field">
          <label class="label" for="studio-password">Password (optional)</label>
          <input
            id="studio-password"
            v-model="previewPassword"
            class="input"
            type="password"
            autocomplete="new-password"
            maxlength="200"
            :disabled="busy"
            placeholder="Password to view this site"
          />
        </div>
        <div v-if="dataApiToggleAvailable" class="field">
          <label class="check">
            <input v-model="previewEnableData" type="checkbox" :disabled="busy" />
            <span>Enable Data API</span>
          </label>
          <p class="hint">Adds password-protected JSON storage. Requires a password.</p>
        </div>

        <div v-if="turnstileEnabled" :ref="setTurnstileContainer" class="turnstile" />

        <button type="button" class="btn-publish" :disabled="!canSubmit" @click="submitPreview">
          {{ busy ? 'Publishing…' : 'Preview & publish a new site' }}
        </button>
      </section>

      <section v-else class="block">
        <h3 class="block-title">Publish changes to {{ target.slug }}</h3>
        <p class="hint">
          Text changes publish back to the same URL; password, expiration, and data settings stay
          unchanged, and no new dashboard row is created.
        </p>

        <div v-if="turnstileEnabled" :ref="setTurnstileContainer" class="turnstile" />

        <button type="button" class="btn-publish" :disabled="!canSubmit" @click="submitChanges">
          {{ busy ? 'Publishing…' : 'Publish changes' }}
        </button>

        <div class="actions">
          <template v-if="!restoreConfirming">
            <button
              type="button"
              class="btn-quiet"
              :disabled="busy || !restoreAvailable"
              @click="restoreConfirming = true"
            >
              Restore previous version
            </button>
          </template>
          <template v-else>
            <p class="warn">
              Restoring discards your current editable changes here and brings back the bytes this site
              had when it was attached. The live site stays unchanged until you publish.
            </p>
            <button type="button" class="btn" :disabled="busy" @click="confirmRestore">
              {{ busy ? 'Restoring…' : 'Restore locally' }}
            </button>
            <button type="button" class="btn-quiet" :disabled="busy" @click="restoreConfirming = false">
              Cancel
            </button>
          </template>
        </div>

        <div class="actions">
          <template v-if="!resetConfirming">
            <button type="button" class="btn-quiet" :disabled="busy" @click="resetConfirming = true">
              Start a new site
            </button>
          </template>
          <template v-else>
            <p class="warn">
              Starting a new site discards the attached draft files and this edit session. The live site
              keeps the files from your last publish.
            </p>
            <button type="button" class="btn" :disabled="busy" @click="confirmReset">
              {{ busy ? 'Resetting…' : 'Discard and start new' }}
            </button>
            <button type="button" class="btn-quiet" :disabled="busy" @click="resetConfirming = false">
              Cancel
            </button>
          </template>
        </div>
      </section>

      <section v-if="published" class="published" aria-live="polite">
        <h3 class="block-title">Published a new site</h3>
        <p class="hint">
          It is live on the isolated hosted origin:
          <a :href="published.url" target="_blank" rel="noopener noreferrer">{{ published.url }}</a>
        </p>
        <div class="actions">
          <a class="btn" :href="published.url" target="_blank" rel="noopener noreferrer">Open site</a>
          <NuxtLink class="btn-quiet" :to="`/result/${published.slug}`">View result details</NuxtLink>
        </div>
      </section>

      <p v-if="!hasFiles && !target" class="hint">
        Send a message first — Preview &amp; publish needs at least one generated file.
      </p>
    </div>
  </div>
</template>

<style scoped>
.publish {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  background: #181820;
}
.pane-head {
  padding: 0.85rem 1rem;
  border-bottom: 1px solid #30303a;
}
.pane-title {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 600;
  color: #f1f1f4;
}
.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.facts {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.fact {
  display: flex;
  gap: 0.6rem;
  font-size: 0.78rem;
}
.fact dt {
  flex: 0 0 4.5rem;
  color: #a1a1aa;
}
.fact dd {
  margin: 0;
  color: #f1f1f4;
  overflow-wrap: anywhere;
}
.fact a {
  color: #a78bfa;
}
.block {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding-top: 1rem;
  border-top: 1px solid #30303a;
}
.block-title {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: #f1f1f4;
}
.hint {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.55;
  color: #a1a1aa;
}
.hint a {
  color: #a78bfa;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.label {
  font-size: 0.75rem;
  color: #a1a1aa;
}
.input {
  width: 100%;
  font: inherit;
  font-size: 0.82rem;
  padding: 0.45rem 0.6rem;
  min-height: 38px;
  color: #f1f1f4;
  background: #0f0f12;
  border: 1px solid #30303a;
  border-radius: 8px;
}
.check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  color: #e4e4e7;
}
.check input {
  width: 1rem;
  height: 1rem;
  accent-color: #a78bfa;
}
.turnstile {
  min-height: 65px;
  display: flex;
  justify-content: center;
}
.btn-publish {
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  padding: 0.6rem 1rem;
  min-height: 44px;
  border-radius: 8px;
  border: 1px solid #fde047;
  background: #fde047;
  color: #1c1a05;
  cursor: pointer;
}
.btn-publish:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn-publish:not(:disabled):hover {
  background: #fce85f;
}
.actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: stretch;
}
.btn,
.btn-quiet {
  font: inherit;
  font-size: 0.8rem;
  font-weight: 500;
  padding: 0.5rem 0.85rem;
  min-height: 40px;
  border-radius: 8px;
  cursor: pointer;
  text-align: center;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.btn {
  border: 1px solid #a78bfa;
  background: rgba(167, 139, 250, 0.16);
  color: #e9e3ff;
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
.warn {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.5;
  color: #fde047;
}
.published {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.85rem;
  border: 1px solid #fde047;
  border-radius: 8px;
  background: rgba(253, 224, 71, 0.06);
}
.published .actions {
  flex-direction: row;
  flex-wrap: wrap;
}
.published .actions > * {
  flex: 1 1 8rem;
}
.input:focus-visible,
.btn:focus-visible,
.btn-quiet:focus-visible,
.btn-publish:focus-visible,
.check input:focus-visible {
  outline: 2px solid #a78bfa;
  outline-offset: 2px;
}
@media (max-width: 640px) {
  .btn,
  .btn-quiet,
  .input {
    min-height: 44px;
  }
}
</style>
