<script setup lang="ts">
import { prepareHtmlForEditor, cleanEditorHtml, useEditTracker } from '~/composables/useHtmlEditor'
import { useEditorBridge } from '~/composables/useEditorBridge'
import type { HoverPayload, SelectPayload } from '~/composables/useEditorBridge'

// ── Phase management ─────────────────────────────────────────────────
type Phase = 'input' | 'edit' | 'export'
const phase = ref<Phase>('input')

// ── Input phase state ────────────────────────────────────────────────
const rawHtml = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const dragging = ref(false)
const inputError = ref<string | null>(null)

function setFile(file: File | null) {
  inputError.value = null
  if (file) {
    if (!file.name.toLowerCase().endsWith('.html')) {
      inputError.value = 'Only .html files are allowed.'
      selectedFile.value = null
      return
    }
  }
  selectedFile.value = file
  if (file) {
    const reader = new FileReader()
    reader.onload = () => {
      rawHtml.value = reader.result as string
    }
    reader.onerror = () => {
      inputError.value = 'Failed to read file.'
    }
    reader.readAsText(file)
  }
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  dragging.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) setFile(file)
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  dragging.value = true
}

function onDragLeave() {
  dragging.value = false
}

function onSelectFile() {
  const file = fileInput.value?.files?.[0]
  setFile(file ?? null)
}

function clearFile() {
  selectedFile.value = null
  rawHtml.value = ''
  inputError.value = null
  if (fileInput.value) fileInput.value.value = ''
}

function changeFile() {
  fileInput.value?.click()
}

// Prevent browser navigation on file drop
const preventDropNav = (e: DragEvent) => {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault()
    e.stopPropagation()
  }
}
onMounted(() => {
  document.addEventListener('drop', preventDropNav, true)
  document.addEventListener('dragover', preventDropNav, true)
})
onUnmounted(() => {
  document.removeEventListener('drop', preventDropNav, true)
  document.removeEventListener('dragover', preventDropNav, true)
})

// ── Edit phase state ─────────────────────────────────────────────────
const preparedHtml = ref('')
const { iframeRef, onHover, onHoverEnd, onSelect, onSerialize, sendUpdate, requestSerialize } = useEditorBridge()
const { edits, trackEdit, editCount, clearEdits } = useEditTracker()

type PopoverState = 'hidden' | 'hovering' | 'editing'
const popoverState = ref<PopoverState>('hidden')
const hoveredInfo = ref<HoverPayload | null>(null)
const editingPath = ref('')
const editingOriginalText = ref('')
const editText = ref('')
const popoverX = ref(0)
const popoverY = ref(0)

function loadIntoEditor() {
  const content = rawHtml.value.trim()
  if (!content) return
  clearEdits()
  preparedHtml.value = prepareHtmlForEditor(content)
  phase.value = 'edit'
}

function backToInput() {
  popoverState.value = 'hidden'
  phase.value = 'input'
}

// Position the popover relative to the iframe element rect
function positionPopover(rect: { top: number; left: number; width: number; height: number }) {
  const iframe = iframeRef.value
  if (!iframe) return
  const iframeRect = iframe.getBoundingClientRect()
  popoverX.value = iframeRect.left + rect.left
  popoverY.value = iframeRect.top + rect.top - 44 // above the element
  // If too close to top, flip below
  if (popoverY.value < iframeRect.top) {
    popoverY.value = iframeRect.top + rect.top + rect.height + 8
  }
}

// Wire up bridge events
onHover.value = (payload: HoverPayload) => {
  if (popoverState.value === 'editing') return // don't interrupt editing
  hoveredInfo.value = payload
  positionPopover(payload.rect)
  popoverState.value = 'hovering'
}

onHoverEnd.value = () => {
  if (popoverState.value === 'editing') return
  popoverState.value = 'hidden'
  hoveredInfo.value = null
}

onSelect.value = (payload: SelectPayload) => {
  startEditing(payload.path, payload.text, payload.tagName, payload.rect)
}

function startEditing(path: string, text: string, _tagName: string, rect: { top: number; left: number; width: number; height: number }) {
  editingPath.value = path
  editingOriginalText.value = text
  editText.value = text
  positionPopover(rect)
  popoverState.value = 'editing'
}

function saveEdit() {
  if (!editingPath.value) return
  const newText = editText.value
  trackEdit(editingPath.value, editingOriginalText.value, newText)
  sendUpdate(editingPath.value, newText)
  popoverState.value = 'hidden'
  editingPath.value = ''
}

function cancelEdit() {
  popoverState.value = 'hidden'
  editingPath.value = ''
}

function clickEdit() {
  if (!hoveredInfo.value) return
  const h = hoveredInfo.value
  startEditing(h.path, h.text, h.tagName, h.rect)
}

// ── Export phase state ───────────────────────────────────────────────
const exportedHtml = ref('')
const copied = ref(false)

function generateHtml() {
  onSerialize.value = (html: string) => {
    exportedHtml.value = cleanEditorHtml(html)
    phase.value = 'export'
    onSerialize.value = null
  }
  requestSerialize()
}

async function copyToClipboard() {
  if (!exportedHtml.value) return
  try {
    await navigator.clipboard.writeText(exportedHtml.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch (_) {}
}

function downloadHtml() {
  if (!exportedHtml.value) return
  const blob = new Blob([exportedHtml.value], { type: 'text/html; charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'index.html'
  a.click()
  URL.revokeObjectURL(a.href)
}

function backToEditor() {
  phase.value = 'edit'
}
</script>

<template>
  <!-- ── Phase 1: Input ──────────────────────────────────────────── -->
  <div v-if="phase === 'input'" class="page">
    <div class="box">
      <h1 class="title">HTML Text Editor</h1>
      <p class="subtitle">Upload an HTML file or paste HTML to edit text visually</p>

      <div
        class="dropzone"
        :class="{ dragging, 'has-file': selectedFile }"
        @drop.prevent="onDrop"
        @dragover.prevent="onDragOver"
        @dragleave="onDragLeave"
        @click="!selectedFile && fileInput?.click()"
      >
        <input
          ref="fileInput"
          type="file"
          accept=".html"
          class="file-input"
          aria-hidden="true"
          tabindex="-1"
          @change="onSelectFile"
        />
        <template v-if="selectedFile">
          <span class="file-name">{{ selectedFile.name }}</span>
          <button type="button" class="clear-file" @click.stop="changeFile">Change file</button>
        </template>
        <template v-else>
          <span>Click or drop an HTML file here</span>
        </template>
      </div>

      <div class="or-divider"><span>or paste HTML below</span></div>

      <div class="textarea-wrap">
        <textarea
          v-model="rawHtml"
          class="textarea"
          placeholder="&lt;!DOCTYPE html&gt;&#10;&lt;html&gt;&#10;  &lt;head&gt;&lt;title&gt;My Page&lt;/title&gt;&lt;/head&gt;&#10;  &lt;body&gt;&lt;h1&gt;Hello&lt;/h1&gt;&lt;/body&gt;&#10;&lt;/html&gt;"
          rows="10"
          spellcheck="false"
        />
      </div>

      <button
        type="button"
        class="submit-btn"
        :disabled="!rawHtml.trim()"
        @click="loadIntoEditor"
      >
        Load into Editor
      </button>

      <div v-if="inputError" class="error-wrap" role="alert">
        <p class="error">{{ inputError }}</p>
        <button type="button" class="error-dismiss" aria-label="Dismiss" @click="inputError = null">×</button>
      </div>

      <NuxtLink to="/" class="back-link">← Back to upload</NuxtLink>
    </div>
  </div>

  <!-- ── Phase 2: Edit ───────────────────────────────────────────── -->
  <div v-else-if="phase === 'edit'" class="editor-page">
    <div class="editor-toolbar">
      <button type="button" class="toolbar-btn" @click="backToInput">← Back</button>
      <span class="toolbar-edits">{{ editCount() }} edit{{ editCount() === 1 ? '' : 's' }}</span>
      <button
        type="button"
        class="toolbar-btn toolbar-btn-generate"
        @click="generateHtml"
      >
        Generate HTML
      </button>
    </div>

    <div class="editor-iframe-wrap">
      <iframe
        ref="iframeRef"
        :srcdoc="preparedHtml"
        class="editor-iframe"
        title="HTML editor preview"
        sandbox="allow-scripts"
      />

      <!-- Hover popover -->
      <div
        v-if="popoverState === 'hovering' && hoveredInfo"
        class="popover"
        :style="{ left: popoverX + 'px', top: popoverY + 'px' }"
      >
        <span class="popover-tag">{{ hoveredInfo.tagName }}</span>
        <button type="button" class="popover-edit-btn" @click="clickEdit">Edit</button>
      </div>

      <!-- Editing popover -->
      <div
        v-if="popoverState === 'editing'"
        class="popover popover-editing"
        :style="{ left: popoverX + 'px', top: popoverY + 'px' }"
      >
        <textarea
          v-model="editText"
          class="popover-textarea"
          rows="3"
          @keydown.enter.ctrl="saveEdit"
          @keydown.escape="cancelEdit"
        />
        <div class="popover-actions">
          <button type="button" class="popover-save" @click="saveEdit">Save</button>
          <button type="button" class="popover-cancel" @click="cancelEdit">Cancel</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Phase 3: Export ─────────────────────────────────────────── -->
  <div v-else class="page">
    <div class="box export-box">
      <h1 class="title">Generated HTML</h1>
      <p class="subtitle">{{ editCount() }} text edit{{ editCount() === 1 ? '' : 's' }} applied</p>

      <div class="textarea-wrap">
        <textarea
          :value="exportedHtml"
          class="textarea"
          rows="12"
          readonly
          spellcheck="false"
        />
      </div>

      <div class="export-actions">
        <button type="button" class="submit-btn" @click="copyToClipboard">
          {{ copied ? 'Copied!' : 'Copy to Clipboard' }}
        </button>
        <button type="button" class="submit-btn submit-btn-secondary" @click="downloadHtml">
          Download as index.html
        </button>
      </div>

      <button type="button" class="back-link-btn" @click="backToEditor">← Back to Editor</button>
    </div>
  </div>
</template>

<style scoped>
/* ── Shared ──────────────────────────────────────────────────────── */
.page {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.box {
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  padding: 2rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  text-align: center;
}
.title {
  margin: 0 0 0.25rem;
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.subtitle {
  margin: 0 0 1.5rem;
  font-size: 0.9rem;
  color: #a1a1aa;
}
.back-link {
  display: inline-block;
  margin-top: 1.5rem;
  font-size: 0.9rem;
  color: #a1a1aa;
  text-decoration: none;
}
.back-link:hover {
  color: #a78bfa;
}
.back-link-btn {
  display: inline-block;
  margin-top: 1rem;
  font-size: 0.9rem;
  color: #a1a1aa;
  background: none;
  border: none;
  cursor: pointer;
  text-decoration: none;
}
.back-link-btn:hover {
  color: #a78bfa;
}

/* ── Input phase ─────────────────────────────────────────────────── */
.dropzone {
  border: 2px dashed rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  padding: 2rem;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
  position: relative;
}
.dropzone:hover {
  border-color: rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.02);
}
.dropzone.dragging {
  border-color: #a78bfa;
  background: rgba(167, 139, 250, 0.08);
}
.dropzone.has-file {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: center;
}
.file-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.file-name {
  font-size: 0.9rem;
  word-break: break-all;
}
.clear-file {
  font-size: 0.8rem;
  padding: 0.25rem 0.5rem;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  color: #a1a1aa;
  cursor: pointer;
}
.clear-file:hover {
  color: #e4e4e7;
  border-color: rgba(255, 255, 255, 0.35);
}

.or-divider {
  display: flex;
  align-items: center;
  margin: 1.25rem 0;
  color: #71717a;
  font-size: 0.8rem;
}
.or-divider::before,
.or-divider::after {
  content: '';
  flex: 1;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}
.or-divider span {
  padding: 0 0.75rem;
}

.textarea-wrap {
  width: 100%;
}
.textarea {
  width: 100%;
  padding: 0.75rem;
  font-size: 0.875rem;
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: #e4e4e7;
  resize: vertical;
  min-height: 6rem;
}
.textarea:focus {
  outline: none;
  border-color: rgba(167, 139, 250, 0.5);
}
.textarea::placeholder {
  color: #71717a;
}
.textarea[readonly] {
  cursor: default;
}

.submit-btn {
  margin-top: 1.25rem;
  width: 100%;
  padding: 0.65rem 1rem;
  font-size: 1rem;
  font-weight: 500;
  background: rgba(167, 139, 250, 0.25);
  border: 1px solid rgba(167, 139, 250, 0.5);
  border-radius: 8px;
  color: #c4b5fd;
  cursor: pointer;
}
.submit-btn:hover:not(:disabled) {
  background: rgba(167, 139, 250, 0.35);
}
.submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.submit-btn-secondary {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.2);
  color: #a1a1aa;
}
.submit-btn-secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
  color: #e4e4e7;
}

.error-wrap {
  margin: 1rem 0 0;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: rgba(248, 113, 113, 0.12);
  border: 1px solid rgba(248, 113, 113, 0.3);
  border-radius: 8px;
}
.error-wrap .error {
  margin: 0;
  flex: 1;
  font-size: 0.875rem;
  color: #f87171;
}
.error-dismiss {
  flex-shrink: 0;
  background: none;
  border: none;
  color: #f87171;
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 0.25rem;
  opacity: 0.9;
}
.error-dismiss:hover {
  opacity: 1;
}

/* ── Edit phase ──────────────────────────────────────────────────── */
.editor-page {
  width: 100%;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.editor-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 1rem;
  background: rgba(0, 0, 0, 0.2);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.toolbar-btn {
  padding: 0.35rem 0.75rem;
  font-size: 0.85rem;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #a1a1aa;
  cursor: pointer;
}
.toolbar-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #e4e4e7;
}
.toolbar-btn-generate {
  margin-left: auto;
  background: rgba(167, 139, 250, 0.25);
  border-color: rgba(167, 139, 250, 0.5);
  color: #c4b5fd;
}
.toolbar-btn-generate:hover {
  background: rgba(167, 139, 250, 0.35);
}
.toolbar-edits {
  font-size: 0.8rem;
  color: #71717a;
}

.editor-iframe-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
}
.editor-iframe {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}

/* ── Popover ─────────────────────────────────────────────────────── */
.popover {
  position: fixed;
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.6rem;
  background: #1e1e28;
  border: 1px solid rgba(167, 139, 250, 0.4);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
}
.popover-tag {
  font-size: 0.75rem;
  font-family: ui-monospace, monospace;
  color: #a78bfa;
  background: rgba(167, 139, 250, 0.15);
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
}
.popover-edit-btn {
  font-size: 0.8rem;
  padding: 0.2rem 0.5rem;
  background: rgba(167, 139, 250, 0.25);
  border: 1px solid rgba(167, 139, 250, 0.5);
  border-radius: 5px;
  color: #c4b5fd;
  cursor: pointer;
}
.popover-edit-btn:hover {
  background: rgba(167, 139, 250, 0.35);
}

.popover-editing {
  flex-direction: column;
  padding: 0.6rem;
  min-width: 260px;
}
.popover-textarea {
  width: 100%;
  padding: 0.5rem;
  font-size: 0.85rem;
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #e4e4e7;
  resize: vertical;
  min-height: 3rem;
}
.popover-textarea:focus {
  outline: none;
  border-color: rgba(167, 139, 250, 0.5);
}
.popover-actions {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.4rem;
}
.popover-save {
  flex: 1;
  padding: 0.3rem 0.6rem;
  font-size: 0.8rem;
  background: rgba(167, 139, 250, 0.25);
  border: 1px solid rgba(167, 139, 250, 0.5);
  border-radius: 5px;
  color: #c4b5fd;
  cursor: pointer;
}
.popover-save:hover {
  background: rgba(167, 139, 250, 0.35);
}
.popover-cancel {
  flex: 1;
  padding: 0.3rem 0.6rem;
  font-size: 0.8rem;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 5px;
  color: #a1a1aa;
  cursor: pointer;
}
.popover-cancel:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #e4e4e7;
}

/* ── Export phase ─────────────────────────────────────────────────── */
.export-box {
  max-width: 600px;
}
.export-actions {
  display: flex;
  flex-direction: column;
  gap: 0;
}
</style>
