// Singleton ref — shared across all component instances
const charged = ref(false)

export function useLightningCharge() {
  return { charged }
}
