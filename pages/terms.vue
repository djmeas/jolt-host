<script setup lang="ts">
const { data } = await useFetch<{ html: string }>('/api/terms')

useSeoMeta({
  title: 'Terms and Conditions',
  description: 'Read the Jolt Host Terms and Conditions to understand your rights and responsibilities when using the service.',
  ogTitle: 'Terms and Conditions — Jolt Host',
  ogDescription: 'Read the Jolt Host Terms and Conditions.',
})

useHead({ link: [{ rel: 'canonical', href: 'https://host.thunderjolt.app/terms' }] })
</script>

<template>
  <div class="page">
    <article class="prose" v-html="data?.html" />
    <NuxtLink to="/" class="back-link">← Back to home</NuxtLink>
  </div>
</template>

<style scoped>
.page {
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
  padding: 2rem 1.5rem 3rem;
  align-self: flex-start;
}
.back-link {
  display: inline-block;
  margin-top: 2rem;
  font-size: 0.9rem;
  color: #a1a1aa;
  text-decoration: none;
}
.back-link:hover {
  color: #a78bfa;
}

/* Prose styles for the rendered markdown */
.prose :deep(h1) {
  font-size: 1.75rem;
  font-weight: 700;
  margin: 0 0 0.25rem;
  color: #f4f4f5;
  letter-spacing: -0.02em;
}
.prose :deep(h2) {
  font-size: 1.15rem;
  font-weight: 600;
  margin: 2rem 0 0.6rem;
  color: #e4e4e7;
  padding-bottom: 0.4rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.prose :deep(h3) {
  font-size: 1rem;
  font-weight: 600;
  margin: 1.5rem 0 0.4rem;
  color: #d4d4d8;
}
.prose :deep(p) {
  margin: 0 0 1rem;
  color: #a1a1aa;
  line-height: 1.75;
  font-size: 0.95rem;
}
.prose :deep(hr) {
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  margin: 1.75rem 0;
}
.prose :deep(ul),
.prose :deep(ol) {
  margin: 0 0 1rem;
  padding-left: 1.5rem;
  color: #a1a1aa;
  font-size: 0.95rem;
  line-height: 1.75;
}
.prose :deep(li) {
  margin: 0.25rem 0;
}
.prose :deep(strong) {
  color: #e4e4e7;
  font-weight: 600;
}
.prose :deep(a) {
  color: #a78bfa;
  text-decoration: none;
}
.prose :deep(a:hover) {
  text-decoration: underline;
}
.prose :deep(code) {
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-size: 0.85em;
  padding: 0.15em 0.4em;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  color: #c4b5fd;
}
.prose :deep(table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
  margin: 0 0 1rem;
}
.prose :deep(th) {
  text-align: left;
  padding: 0.5rem 0.75rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #d4d4d8;
  font-weight: 600;
}
.prose :deep(td) {
  padding: 0.5rem 0.75rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #a1a1aa;
  vertical-align: top;
}
.prose :deep(tr:nth-child(even) td) {
  background: rgba(255, 255, 255, 0.02);
}
</style>
