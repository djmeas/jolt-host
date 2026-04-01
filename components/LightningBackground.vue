<script setup lang="ts">
interface Bolt {
  id: number
  x: number
  y: number
  size: number
  baseOpacity: number
  rotation: number
  floatDuration: number
  floatDelay: number
  chargeDuration: number
  chargePhase: number
}

const COLS = 6
const ROWS = 6
const RADIUS = 170

function rand(min: number, max: number) {
  return min + Math.random() * (max - min)
}

const bolts = ref<Bolt[]>([])
const mouse = ref({ x: -9999, y: -9999 })
const { charged } = useLightningCharge()

// Decouple the CSS class from the raw charged state so we can fade
// the background out before swapping the animation back to float.
const animCharged = ref(false)
const bgFaded = ref(false)
let returnTimer: ReturnType<typeof setTimeout> | null = null

watch(() => charged.value, (val) => {
  if (val) {
    if (returnTimer) { clearTimeout(returnTimer); returnTimer = null }
    bgFaded.value = false
    animCharged.value = true
  } else {
    // Fade the background out, swap animation while invisible, fade back in
    bgFaded.value = true
    returnTimer = setTimeout(() => {
      animCharged.value = false
      bgFaded.value = false
      returnTimer = null
    }, 180)
  }
})

onMounted(() => {
  const generated: Bolt[] = []
  let id = 0
  for (let r = 0; r < ROWS; r++) {
    const isEven = r % 2 === 0
    const count = isEven ? COLS : COLS - 1
    const xStep = 100 / COLS
    const xStart = isEven ? xStep / 2 : xStep
    const y = (r / (ROWS - 1)) * 80 + 10
    for (let c = 0; c < count; c++) {
      const chargeDuration = rand(0.55, 1.3)
      generated.push({
        id: id++,
        x: xStart + c * xStep,
        y,
        size: rand(26, 56),
        baseOpacity: rand(0.03, 0.08),
        rotation: rand(-25, 25),
        floatDuration: rand(5, 12),
        floatDelay: rand(0, 10),
        chargeDuration,
        chargePhase: rand(0, chargeDuration),
      })
    }
  }
  bolts.value = generated

  window.addEventListener('mousemove', onMouseMove, { passive: true })
  document.documentElement.addEventListener('mouseleave', onMouseLeave)
})

onUnmounted(() => {
  if (returnTimer) clearTimeout(returnTimer)
  window.removeEventListener('mousemove', onMouseMove)
  document.documentElement.removeEventListener('mouseleave', onMouseLeave)
})

function onMouseMove(e: MouseEvent) {
  mouse.value = { x: e.clientX, y: e.clientY }
}

function onMouseLeave() {
  mouse.value = { x: -9999, y: -9999 }
}

function wrapStyle(bolt: Bolt) {
  return {
    left: `${bolt.x}%`,
    top: `${bolt.y}%`,
    width: `${bolt.size}px`,
    height: `${bolt.size}px`,
    '--float-dur': `${bolt.floatDuration}s`,
    '--float-delay': `-${bolt.floatDelay}s`,
    '--charge-dur': `${bolt.chargeDuration}s`,
    '--charge-phase': `-${bolt.chargePhase}s`,
  }
}

function svgStyle(bolt: Bolt) {
  const bx = (bolt.x / 100) * window.innerWidth
  const by = (bolt.y / 100) * window.innerHeight
  const dx = mouse.value.x - bx
  const dy = mouse.value.y - by
  const dist = Math.sqrt(dx * dx + dy * dy)

  let opacity = bolt.baseOpacity
  let scale = 1
  let tx = 0
  let ty = 0
  let filter = 'none'

  if (dist < RADIUS && dist > 0) {
    const t = 1 - dist / RADIUS
    opacity = bolt.baseOpacity + t * 0.28
    scale = 1 + t * 0.55
    tx = dx * t * 0.18
    ty = dy * t * 0.18
    const blur = Math.round(t * 9)
    filter = `drop-shadow(0 0 ${blur}px rgba(253, 224, 71, ${(t * 0.75).toFixed(2)}))`
  }

  return {
    opacity,
    filter,
    transform: `rotate(${bolt.rotation}deg) translate(${tx}px, ${ty}px) scale(${scale})`,
  }
}
</script>

<template>
  <div class="lightning-bg" :class="{ 'is-faded': bgFaded }" aria-hidden="true">
    <div
      v-for="bolt in bolts"
      :key="bolt.id"
      class="bolt-wrap"
      :class="{ 'is-charged': animCharged }"
      :style="wrapStyle(bolt)"
    >
      <svg
        class="bolt-svg"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        :style="svgStyle(bolt)"
      >
        <path d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.lightning-bg {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  overflow: hidden;
  color: #fde047;
  transition: opacity 0.15s ease;
}
.lightning-bg.is-faded {
  opacity: 0;
}
.bolt-wrap {
  position: absolute;
  animation-name: bolt-float;
  animation-duration: var(--float-dur);
  animation-delay: var(--float-delay);
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
  animation-direction: alternate;
}
.bolt-wrap.is-charged {
  animation-name: bolt-charge;
  animation-duration: var(--charge-dur);
  animation-delay: var(--charge-phase);
  animation-timing-function: cubic-bezier(0.4, 0, 1, 1);
  animation-iteration-count: infinite;
  animation-direction: normal;
}
.bolt-svg {
  width: 100%;
  height: 100%;
  fill: currentColor;
  display: block;
  transform-origin: center;
  transition: transform 0.4s ease, opacity 0.4s ease, filter 0.4s ease;
}
/* Brighten bolts during charge so they feel energised rather than fading out */
.bolt-wrap.is-charged .bolt-svg {
  filter: brightness(4) drop-shadow(0 0 5px rgba(253, 224, 71, 0.6)) !important;
  transition: filter 0.2s ease;
}
@keyframes bolt-float {
  from { transform: translateY(-10px); }
  to   { transform: translateY(10px); }
}
@keyframes bolt-charge {
  /* Start visible at the bolt's resting position, accelerate upward, fade out at the top before looping */
  0%   { transform: translateY(0);       opacity: 1;   }
  75%  { transform: translateY(-60vh);   opacity: 0.6; }
  100% { transform: translateY(-110vh);  opacity: 0;   }
}
</style>
