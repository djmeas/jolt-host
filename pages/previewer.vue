<script setup lang="ts">
useSeoMeta({
  title: 'HTML Previewer',
  description: 'Preview HTML live in a split-view editor. Paste or type HTML and see the result instantly.',
  ogTitle: 'HTML Previewer — Jolt Host',
  ogDescription: 'Preview HTML live in a split-view editor. Paste or type HTML and see the result instantly.',
})

useHead({ link: [{ rel: 'canonical', href: 'https://host.thunderjolt.app/previewer' }] })

const html = ref('')

type FocusMode = 'balanced' | 'preview' | 'input'
const focusMode = ref<FocusMode>('balanced')

// Wrap fragment in full document so preview renders correctly
const previewHtml = computed(() => {
  const raw = html.value.trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (lower.startsWith('<!doctype') || lower.startsWith('<html')) {
    return raw
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${raw}</body></html>`
})

function minimizePreview() {
  focusMode.value = 'input'
}
function minimizeInput() {
  focusMode.value = 'preview'
}
function resetSplit() {
  focusMode.value = 'balanced'
}

function openFullScreen() {
  const content = previewHtml.value
  if (!content) return
  const blob = new Blob([content], { type: 'text/html; charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const win = window.open(url, '_blank', 'noopener')
  if (win) {
    URL.revokeObjectURL(url)
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1 class="title">HTML Previewer</h1>
      <p class="subtitle">Paste HTML below to preview in the browser. Nothing is published or saved.</p>
      <NuxtLink to="/" class="back-link">← Back to upload</NuxtLink>
    </header>

    <div class="panes" :data-focus="focusMode">
      <div class="pane pane-preview">
        <div class="pane-inner">
          <iframe
            v-if="previewHtml"
            :srcdoc="previewHtml"
            class="preview-iframe"
            title="HTML preview"
            sandbox="allow-scripts"
          />
          <div v-else class="preview-empty">Enter HTML in the pane below to see the preview.</div>
        </div>
      </div>

      <div class="splitter" role="separator" aria-label="Pane splitter">
        <div class="splitter-buttons">
          <button
            type="button"
            class="splitter-btn"
            :class="{ active: focusMode === 'input' }"
            title="Focus HTML input"
            :aria-pressed="focusMode === 'input'"
            @click="minimizePreview"
          >
            Minimize preview
          </button>
          <button
            type="button"
            class="splitter-btn splitter-btn-reset"
            title="Equal split"
            :disabled="focusMode === 'balanced'"
            @click="resetSplit"
          >
            Split
          </button>
          <button
            type="button"
            class="splitter-btn"
            :class="{ active: focusMode === 'preview' }"
            title="Focus preview"
            :aria-pressed="focusMode === 'preview'"
            @click="minimizeInput"
          >
            Minimize HTML
          </button>
          <button
            type="button"
            class="splitter-btn splitter-btn-fullscreen"
            title="Open rendered HTML in new tab (no Jolt Host UI)"
            :disabled="!previewHtml"
            @click="openFullScreen"
          >
            Full Page Preview
          </button>
        </div>
      </div>

      <div class="pane pane-input">
        <div class="pane-inner">
          <textarea
            v-model="html"
            class="textarea"
            placeholder="&lt;!DOCTYPE html&gt;&#10;&lt;html&gt;&#10;  &lt;head&gt;&lt;title&gt;My Page&lt;/title&gt;&lt;/head&gt;&#10;  &lt;body&gt;&lt;h1&gt;Hello&lt;/h1&gt;&lt;/body&gt;&#10;&lt;/html&gt;"
            spellcheck="false"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  width: 100%;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.page-header {
  flex-shrink: 0;
  padding: 0.75rem 1rem;
  text-align: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(0, 0, 0, 0.15);
}
.title {
  margin: 0 0 0.15rem;
  font-size: 1.15rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.subtitle {
  margin: 0 0 0.35rem;
  font-size: 0.85rem;
  color: #a1a1aa;
}
.back-link {
  font-size: 0.85rem;
  color: #a1a1aa;
  text-decoration: none;
}
.back-link:hover {
  color: #a78bfa;
}

.panes {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: rgba(255, 255, 255, 0.04);
  border: none;
  border-radius: 0;
  overflow: hidden;
}

.pane {
  min-height: 80px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pane-inner {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0.75rem;
}
.pane-preview .pane-inner {
  padding-bottom: 0.25rem;
}
.pane-input .pane-inner {
  padding-top: 0.25rem;
}

/* Balanced: 50/50 */
.panes[data-focus='balanced'] .pane-preview {
  flex: 1 1 50%;
}
.panes[data-focus='balanced'] .pane-input {
  flex: 1 1 50%;
}

/* Focus input: minimize preview */
.panes[data-focus='input'] .pane-preview {
  flex: 0 0 80px;
}
.panes[data-focus='input'] .pane-input {
  flex: 1 1 auto;
}

/* Focus preview: minimize input */
.panes[data-focus='preview'] .pane-preview {
  flex: 1 1 auto;
}
.panes[data-focus='preview'] .pane-input {
  flex: 0 0 80px;
}

.preview-iframe {
  width: 100%;
  height: 100%;
  min-height: 120px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  background: #fff;
}
.preview-empty {
  height: 100%;
  min-height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
  color: #71717a;
  border: 1px dashed rgba(255, 255, 255, 0.12);
  border-radius: 8px;
}

.splitter {
  flex-shrink: 0;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.06);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.splitter-buttons {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.splitter-btn {
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #a1a1aa;
  cursor: pointer;
}
.splitter-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
  color: #e4e4e7;
  border-color: rgba(255, 255, 255, 0.25);
}
.splitter-btn.active {
  background: rgba(167, 139, 250, 0.2);
  border-color: rgba(167, 139, 250, 0.4);
  color: #c4b5fd;
}
.splitter-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.splitter-btn-reset {
  margin: 0 0.25rem;
}
.splitter-btn-fullscreen {
  margin-left: 0.75rem;
  border-left: 1px solid rgba(255, 255, 255, 0.15);
  padding-left: 0.75rem;
}

.textarea {
  width: 100%;
  height: 100%;
  min-height: 100px;
  padding: 0.75rem;
  font-size: 0.875rem;
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: #e4e4e7;
  resize: none;
}
.textarea:focus {
  outline: none;
  border-color: rgba(167, 139, 250, 0.5);
}
.textarea::placeholder {
  color: #71717a;
}
</style>
