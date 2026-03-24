/**
 * Composable that manages communication between the parent editor page
 * and a bridge script injected into the user's HTML inside an iframe.
 *
 * The bridge script (running inside the iframe) detects hover/click on
 * leaf text elements and reports them via postMessage. The parent can
 * send text updates and serialization requests back.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface HoverPayload {
  path: string
  html: string
  tagName: string
  rect: { top: number; left: number; width: number; height: number }
}

export interface SelectPayload {
  path: string
  html: string
  tagName: string
  rect: { top: number; left: number; width: number; height: number }
}

type BridgeMessage =
  | { type: 'jolt-editor-hover'; payload: HoverPayload }
  | { type: 'jolt-editor-hover-end' }
  | { type: 'jolt-editor-select'; payload: SelectPayload }
  | { type: 'jolt-editor-html'; html: string }

// ── Injected script (string) ────────────────────────────────────────

const BRIDGE_MARKER_START = '<!-- jolt-editor-bridge -->'
const BRIDGE_MARKER_END = '<!-- /jolt-editor-bridge -->'

/**
 * Returns the full HTML block (style + script) to inject before </body>.
 */
export function getEditorBridgeHtml(): string {
  return `${BRIDGE_MARKER_START}
<style data-jolt-editor>
  [data-jolt-hover] {
    outline: 2px solid rgba(167, 139, 250, 0.5) !important;
    outline-offset: 2px;
    cursor: pointer !important;
  }
</style>
<script data-jolt-editor>
(function() {
  // Build a CSS-path selector for a DOM element
  function cssPath(el) {
    var parts = [];
    while (el && el !== document.documentElement) {
      if (el === document.body) { parts.unshift('body'); break; }
      var parent = el.parentElement;
      if (!parent) break;
      var tag = el.tagName.toLowerCase();
      var siblings = Array.from(parent.children).filter(function(c) {
        return c.tagName === el.tagName;
      });
      if (siblings.length > 1) {
        var idx = siblings.indexOf(el) + 1;
        tag += ':nth-of-type(' + idx + ')';
      }
      parts.unshift(tag);
      el = parent;
    }
    return parts.join(' > ');
  }

  // Check if an element is a valid hover target:
  // has non-empty textContent and is not a structural/meta tag
  var SKIP_TAGS = { HTML: 1, BODY: 1, HEAD: 1, SCRIPT: 1, STYLE: 1, META: 1, LINK: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  function hasText(el) {
    if (!el || !el.tagName) return false;
    if (SKIP_TAGS[el.tagName]) return false;
    if (el.hasAttribute && el.hasAttribute('data-jolt-editor')) return false;
    return el.textContent.trim().length > 0;
  }

  // Find the deepest text-containing element at coordinates
  function findTextElemAt(x, y) {
    var els = document.elementsFromPoint(x, y);
    for (var i = 0; i < els.length; i++) {
      if (els[i].hasAttribute && els[i].hasAttribute('data-jolt-editor')) continue;
      if (hasText(els[i])) return els[i];
    }
    return null;
  }

  var currentHover = null;

  document.addEventListener('mousemove', function(e) {
    var el = findTextElemAt(e.clientX, e.clientY);
    if (el === currentHover) return;

    // Remove old highlight
    if (currentHover) currentHover.removeAttribute('data-jolt-hover');

    currentHover = el;
    if (!el) {
      parent.postMessage({ type: 'jolt-editor-hover-end' }, '*');
      return;
    }

    el.setAttribute('data-jolt-hover', '');
    var rect = el.getBoundingClientRect();
    parent.postMessage({
      type: 'jolt-editor-hover',
      payload: {
        path: cssPath(el),
        html: el.innerHTML,
        tagName: el.tagName.toLowerCase(),
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
      }
    }, '*');
  }, { passive: true });

  document.addEventListener('click', function(e) {
    var el = findTextElemAt(e.clientX, e.clientY);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    var rect = el.getBoundingClientRect();
    parent.postMessage({
      type: 'jolt-editor-select',
      payload: {
        path: cssPath(el),
        html: el.innerHTML,
        tagName: el.tagName.toLowerCase(),
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
      }
    }, '*');
  }, true);

  document.addEventListener('mouseleave', function() {
    if (currentHover) {
      currentHover.removeAttribute('data-jolt-hover');
      currentHover = null;
    }
    parent.postMessage({ type: 'jolt-editor-hover-end' }, '*');
  });

  // Listen for commands from the parent
  window.addEventListener('message', function(e) {
    var data = e.data;
    if (!data || !data.type) return;

    if (data.type === 'jolt-editor-update') {
      var target = document.querySelector(data.path);
      if (target) target.innerHTML = data.newHtml;
    }

    if (data.type === 'jolt-editor-serialize') {
      // Remove editor artifacts before serializing
      var hovered = document.querySelector('[data-jolt-hover]');
      if (hovered) hovered.removeAttribute('data-jolt-hover');
      parent.postMessage({
        type: 'jolt-editor-html',
        html: '<!DOCTYPE html>\\n' + document.documentElement.outerHTML
      }, '*');
    }
  });
})();
<\/script>
${BRIDGE_MARKER_END}`
}

// ── Composable ──────────────────────────────────────────────────────

export function useEditorBridge() {
  const iframeRef = ref<HTMLIFrameElement | null>(null)

  const onHover = ref<((payload: HoverPayload) => void) | null>(null)
  const onHoverEnd = ref<(() => void) | null>(null)
  const onSelect = ref<((payload: SelectPayload) => void) | null>(null)
  const onSerialize = ref<((html: string) => void) | null>(null)

  function handleMessage(event: MessageEvent) {
    const data = event.data as BridgeMessage
    if (!data || !data.type || !data.type.startsWith('jolt-editor-')) return

    switch (data.type) {
      case 'jolt-editor-hover':
        onHover.value?.(data.payload)
        break
      case 'jolt-editor-hover-end':
        onHoverEnd.value?.()
        break
      case 'jolt-editor-select':
        onSelect.value?.(data.payload)
        break
      case 'jolt-editor-html':
        onSerialize.value?.(data.html)
        break
    }
  }

  function sendUpdate(path: string, newHtml: string) {
    iframeRef.value?.contentWindow?.postMessage(
      { type: 'jolt-editor-update', path, newHtml },
      '*',
    )
  }

  function requestSerialize() {
    iframeRef.value?.contentWindow?.postMessage(
      { type: 'jolt-editor-serialize' },
      '*',
    )
  }

  onMounted(() => {
    window.addEventListener('message', handleMessage)
  })

  onUnmounted(() => {
    window.removeEventListener('message', handleMessage)
  })

  return {
    iframeRef,
    onHover,
    onHoverEnd,
    onSelect,
    onSerialize,
    sendUpdate,
    requestSerialize,
  }
}
