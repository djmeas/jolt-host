<script setup lang="ts">
import { computed, ref } from 'vue'
import { countMessageBytes, type TranscriptMessage } from '~/composables/useAiWorkspace'

/**
 * Conversation pane: transcript, model summary, and the sticky composer.
 *
 * Replies are rendered with Vue interpolation only — the workspace is a private
 * draft and nothing here executes on the app origin. Enter inserts a newline;
 * Cmd/Ctrl+Enter sends.
 */
const props = defineProps<{
  messages: TranscriptMessage[]
  busy: boolean
  notice: string | null
  maxBytes: number
  loading: boolean
  loaded: boolean
  send: (text: string) => Promise<boolean>
}>()

const draft = ref('')
const draftBytes = computed(() => countMessageBytes(draft.value))
const draftTooLong = computed(() => draftBytes.value > props.maxBytes)
const canSend = computed(() => !props.busy && draft.value.trim().length > 0 && !draftTooLong.value)

async function submit() {
  if (!canSend.value) return
  const accepted = await props.send(draft.value)
  // A failed paid turn keeps the draft so it can be edited and resent.
  if (accepted) draft.value = ''
}
</script>

<template>
  <div class="conversation">
    <div class="pane-head">
      <h2 class="pane-title">Conversation</h2>
      <span class="pane-live" aria-live="polite">
        <span v-if="busy" class="pane-state">Working…</span>
        <span v-else-if="loading" class="pane-state">Loading workspace…</span>
      </span>
    </div>

    <div class="transcript" aria-live="polite">
      <p v-if="loaded && !messages.length" class="empty">
        No messages yet. Describe the site you want to build — the model writes the files into this
        private draft.
      </p>
      <div
        v-for="item in messages"
        :key="item.id"
        class="msg"
        :class="item.role === 'user' ? 'msg-user' : 'msg-assistant'"
      >
        <div class="msg-role">
          {{ item.role === 'user' ? 'You' : 'Builder' }}
          <span v-if="item.status !== 'ok'" class="msg-status">{{ item.status }}</span>
        </div>
        <p class="msg-content">{{ item.content }}</p>
      </div>

      <p v-if="notice" class="change-note">
        <span class="change-label">Last change</span>
        {{ notice }}
      </p>
    </div>

    <div class="composer">
      <label class="label" for="studio-message">Describe a new site or a change</label>
      <textarea
        id="studio-message"
        v-model="draft"
        class="textarea"
        rows="3"
        :disabled="busy"
        placeholder="A one-page portfolio with a dark theme and a contact section"
        @keydown.meta.enter.prevent="submit"
        @keydown.ctrl.enter.prevent="submit"
      />
      <div class="composer-foot">
        <span class="counter" :class="{ over: draftTooLong }">
          {{ draftBytes }} / {{ maxBytes }} bytes
        </span>
        <span class="key-hint">Cmd/Ctrl + Enter sends</span>
        <button
          type="button"
          class="btn btn-send"
          :disabled="!canSend"
          @click="submit"
        >
          {{ busy ? 'Working…' : 'Send' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.conversation {
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
  letter-spacing: 0.01em;
  color: #f1f1f4;
}
.pane-state {
  font-size: 0.75rem;
  color: #a78bfa;
}
.pane-live {
  min-height: 1rem;
}
.transcript {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}
.empty {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.55;
  color: #a1a1aa;
  max-width: 46ch;
}
.msg-role {
  font-size: 0.72rem;
  font-weight: 600;
  color: #a1a1aa;
}
.msg-status {
  margin-left: 0.5rem;
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  background: rgba(253, 224, 71, 0.15);
  color: #fde047;
  font-weight: 500;
}
.msg-content {
  margin: 0.3rem 0 0;
  font-size: 0.875rem;
  line-height: 1.6;
  color: #f1f1f4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.msg-user .msg-content {
  color: #e4e4e7;
}
.msg-assistant .msg-content {
  border-left: 2px solid #a78bfa;
  padding-left: 0.75rem;
}
.change-note {
  margin: 0;
  padding: 0.6rem 0.75rem;
  border: 1px solid #30303a;
  border-left: 2px solid #fde047;
  border-radius: 6px;
  background: rgba(253, 224, 71, 0.06);
  font-size: 0.8rem;
  line-height: 1.5;
  color: #e4e4e7;
}
.change-label {
  display: block;
  font-size: 0.7rem;
  font-weight: 600;
  color: #fde047;
  margin-bottom: 0.15rem;
}
.composer {
  border-top: 1px solid #30303a;
  padding: 0.85rem 1rem calc(0.85rem + env(safe-area-inset-bottom));
  background: #14141a;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.label {
  font-size: 0.78rem;
  color: #a1a1aa;
}
.textarea {
  width: 100%;
  resize: vertical;
  min-height: 4.5rem;
  padding: 0.6rem 0.7rem;
  font: inherit;
  font-size: 0.875rem;
  line-height: 1.5;
  color: #f1f1f4;
  background: #0f0f12;
  border: 1px solid #30303a;
  border-radius: 8px;
}
.textarea::placeholder {
  color: #6b6b76;
}
.textarea:disabled {
  opacity: 0.6;
}
.composer-foot {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.counter {
  font-size: 0.75rem;
  color: #a1a1aa;
}
.counter.over {
  color: #f87171;
}
.key-hint {
  font-size: 0.72rem;
  color: #6b6b76;
  margin-right: auto;
}
.btn {
  font: inherit;
  font-size: 0.82rem;
  font-weight: 600;
  padding: 0.5rem 1rem;
  min-height: 40px;
  border-radius: 8px;
  border: 1px solid #30303a;
  background: #1f1f28;
  color: #f1f1f4;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-send {
  background: #a78bfa;
  border-color: #a78bfa;
  color: #17131f;
}
.btn-send:not(:disabled):hover {
  background: #b9a2fb;
}
.textarea:focus-visible,
.btn:focus-visible {
  outline: 2px solid #a78bfa;
  outline-offset: 2px;
}
@media (max-width: 640px) {
  .btn {
    min-height: 44px;
    width: 100%;
  }
  .key-hint {
    display: none;
  }
}
</style>
