<script setup lang="ts">
import { computed } from 'vue'
import type { WorkspaceFile } from '~/composables/useAiWorkspace'

/**
 * Source pane: the workspace file tree plus a read-only source inspector.
 *
 * Source is plain JSON text rendered through interpolation — never HTML — and
 * the model is the only writer of editable files, so this pane has no editor.
 */
const props = defineProps<{
  files: WorkspaceFile[]
  editableFiles: number
  opaqueFiles: number
  editableBytes: number
  openPath: string | null
  openContent: string | null
  openLoading: boolean
  openError: string | null
  busy: boolean
  open: (file: WorkspaceFile) => void
  close: () => void
}>()

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

const summary = computed(() =>
  `${props.editableFiles} text · ${props.opaqueFiles} asset · ${formatBytes(props.editableBytes)}`
)
</script>

<template>
  <div class="files">
    <div class="pane-head">
      <h2 class="pane-title">Files</h2>
      <span class="count">{{ summary }}</span>
    </div>

    <div class="file-tree">
      <p v-if="!files.length" class="empty">
        This workspace is private — nothing is published yet. Describe the first site you want to build
        and the model writes its files here.
      </p>
      <ul v-else class="file-list">
        <li v-for="file in files" :key="file.path">
          <button
            v-if="file.editable"
            type="button"
            class="file"
            :class="{ active: openPath === file.path }"
            :aria-current="openPath === file.path ? 'true' : undefined"
            :disabled="busy"
            @click="open(file)"
          >
            <span class="file-path">{{ file.path }}</span>
            <span class="file-tag">text</span>
          </button>
          <div v-else class="file file-opaque">
            <span class="file-path">{{ file.path }}</span>
            <span class="file-tag file-tag-asset">asset</span>
          </div>
        </li>
      </ul>
    </div>

    <div class="inspector">
      <div v-if="!openPath" class="inspector-empty">
        <p class="empty">
          Select a text file to read its source. Assets carried over from an attached site are kept as
          retained assets and cannot be read or edited as text.
        </p>
      </div>
      <template v-else>
        <div class="inspector-head">
          <span class="inspector-path">{{ openPath }}</span>
          <span class="read-only">Read-only</span>
          <button type="button" class="link-btn" @click="close">Close</button>
        </div>
        <p v-if="openError" class="alert" role="alert">{{ openError }}</p>
        <pre v-else-if="openLoading" class="source">Loading…</pre>
        <pre v-else class="source">{{ openContent }}</pre>
      </template>
    </div>
  </div>
</template>

<style scoped>
.files {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  background: #181820;
}
.pane-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid #30303a;
}
.pane-title {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 600;
  color: #f1f1f4;
}
.count {
  font-size: 0.75rem;
  color: #a1a1aa;
}
.file-tree {
  flex: 0 1 auto;
  max-height: 38%;
  overflow-y: auto;
  border-bottom: 1px solid #30303a;
}
.empty {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.55;
  color: #a1a1aa;
  max-width: 52ch;
  padding: 0.9rem 1rem;
}
.file-list {
  list-style: none;
  margin: 0;
  padding: 0.4rem 0;
}
.file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  width: 100%;
  padding: 0.45rem 1rem;
  min-height: 36px;
  font: inherit;
  font-size: 0.8rem;
  text-align: left;
  color: #e4e4e7;
  background: transparent;
  border: 0;
}
button.file {
  cursor: pointer;
}
button.file:hover:not(:disabled) {
  background: rgba(167, 139, 250, 0.08);
}
button.file.active {
  background: rgba(167, 139, 250, 0.14);
  box-shadow: inset 2px 0 0 #a78bfa;
}
.file-opaque {
  color: #a1a1aa;
}
.file-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
}
.file-tag {
  flex-shrink: 0;
  font-size: 0.68rem;
  color: #a78bfa;
}
.file-tag-asset {
  color: #a1a1aa;
}
.inspector {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #0f0f12;
}
.inspector-empty {
  flex: 1;
  display: flex;
  align-items: flex-start;
}
.inspector-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid #30303a;
}
.inspector-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
  color: #f1f1f4;
  overflow-wrap: anywhere;
}
.read-only {
  font-size: 0.7rem;
  color: #a1a1aa;
  border: 1px solid #30303a;
  border-radius: 999px;
  padding: 0.05rem 0.5rem;
}
.link-btn {
  margin-left: auto;
  font: inherit;
  font-size: 0.75rem;
  color: #a78bfa;
  background: none;
  border: 0;
  padding: 0.25rem 0.4rem;
  cursor: pointer;
}
.source {
  flex: 1;
  min-height: 0;
  margin: 0;
  overflow: auto;
  padding: 0.9rem 1rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
  line-height: 1.6;
  color: #d4d4d8;
  white-space: pre;
}
.alert {
  margin: 0.9rem 1rem;
  font-size: 0.82rem;
  color: #fca5a5;
}
button.file:focus-visible,
.link-btn:focus-visible {
  outline: 2px solid #a78bfa;
  outline-offset: -2px;
}
@media (max-width: 900px) {
  .file-tree {
    max-height: 45%;
  }
}
@media (max-width: 640px) {
  .file {
    min-height: 44px;
  }
}
</style>
