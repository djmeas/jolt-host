import { marked } from 'marked'

const THEMES = ['github', 'dracula', 'solarized', 'nord'] as const
type Theme = (typeof THEMES)[number]

const THEME_LABELS: Record<Theme, string> = {
  github: 'GitHub',
  dracula: 'Dracula',
  solarized: 'Solarized',
  nord: 'Nord',
}

/** All theme definitions as CSS custom properties. */
const THEME_CSS = `
:root, [data-theme="github"] {
  --md-bg: #ffffff;
  --md-surface: #f6f8fa;
  --md-border: #d0d7de;
  --md-text: #1f2328;
  --md-muted: #656d76;
  --md-heading: #1f2328;
  --md-link: #0969da;
  --md-link-hover: #0550ae;
  --md-code-bg: #f6f8fa;
  --md-code-text: #e36209;
  --md-code-border: #d0d7de;
  --md-pre-bg: #f6f8fa;
  --md-pre-text: #1f2328;
  --md-blockquote-border: #d0d7de;
  --md-blockquote-text: #656d76;
  --md-table-border: #d0d7de;
  --md-table-header-bg: #f6f8fa;
  --md-table-stripe: #f6f8fa;
  --md-hr: #d0d7de;
}

[data-theme="dracula"] {
  --md-bg: #282a36;
  --md-surface: #44475a;
  --md-border: #6272a4;
  --md-text: #f8f8f2;
  --md-muted: #6272a4;
  --md-heading: #f8f8f2;
  --md-link: #8be9fd;
  --md-link-hover: #80d7f0;
  --md-code-bg: #44475a;
  --md-code-text: #ffb86c;
  --md-code-border: #6272a4;
  --md-pre-bg: #44475a;
  --md-pre-text: #f8f8f2;
  --md-blockquote-border: #6272a4;
  --md-blockquote-text: #6272a4;
  --md-table-border: #6272a4;
  --md-table-header-bg: #44475a;
  --md-table-stripe: #323344;
  --md-hr: #6272a4;
  --md-toolbar-bg: rgba(68, 71, 90, 0.95);
  --md-toolbar-border: rgba(98, 114, 164, 0.6);
  --md-toolbar-shadow: rgba(0, 0, 0, 0.4);
}

[data-theme="solarized"] {
  --md-bg: #fdf6e3;
  --md-surface: #eee8d5;
  --md-border: #d3cbb8;
  --md-text: #657b83;
  --md-muted: #93a1a1;
  --md-heading: #586e75;
  --md-link: #268bd2;
  --md-link-hover: #1a6fa8;
  --md-code-bg: #eee8d5;
  --md-code-text: #cb4b16;
  --md-code-border: #d3cbb8;
  --md-pre-bg: #eee8d5;
  --md-pre-text: #657b83;
  --md-blockquote-border: #93a1a1;
  --md-blockquote-text: #93a1a1;
  --md-table-border: #d3cbb8;
  --md-table-header-bg: #eee8d5;
  --md-table-stripe: #f5f0e4;
  --md-hr: #d3cbb8;
  --md-toolbar-bg: rgba(238, 232, 213, 0.95);
  --md-toolbar-border: rgba(211, 203, 184, 0.8);
  --md-toolbar-shadow: rgba(88, 110, 117, 0.15);
}

[data-theme="nord"] {
  --md-bg: #2e3440;
  --md-surface: #3b4252;
  --md-border: #4c566a;
  --md-text: #d8dee9;
  --md-muted: #616e88;
  --md-heading: #eceff4;
  --md-link: #88c0d0;
  --md-link-hover: #81b4c4;
  --md-code-bg: #3b4252;
  --md-code-text: #ebcb8b;
  --md-code-border: #4c566a;
  --md-pre-bg: #3b4252;
  --md-pre-text: #d8dee9;
  --md-blockquote-border: #4c566a;
  --md-blockquote-text: #616e88;
  --md-table-border: #4c566a;
  --md-table-header-bg: #3b4252;
  --md-table-stripe: #323847;
  --md-hr: #4c566a;
  --md-toolbar-bg: rgba(59, 66, 82, 0.95);
  --md-toolbar-border: rgba(76, 86, 106, 0.7);
  --md-toolbar-shadow: rgba(0, 0, 0, 0.35);
}
`

/** Base prose styles using CSS custom properties. */
const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }

html { font-size: 16px; }

body {
  margin: 0;
  padding: 2rem 1rem 4rem;
  background: var(--md-bg);
  color: var(--md-text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
  font-size: 1rem;
  line-height: 1.75;
  transition: background 0.2s ease, color 0.2s ease;
}

.markdown-body {
  max-width: 800px;
  margin: 0 auto;
}

/* Headings */
.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 {
  color: var(--md-heading);
  font-weight: 600;
  line-height: 1.3;
  margin: 1.75rem 0 0.75rem;
}
.markdown-body h1 { font-size: 2rem; padding-bottom: 0.4em; border-bottom: 1px solid var(--md-border); }
.markdown-body h2 { font-size: 1.5rem; padding-bottom: 0.3em; border-bottom: 1px solid var(--md-border); }
.markdown-body h3 { font-size: 1.25rem; }
.markdown-body h4 { font-size: 1rem; }
.markdown-body h5 { font-size: 0.875rem; }
.markdown-body h6 { font-size: 0.85rem; color: var(--md-muted); }
.markdown-body h1:first-child,
.markdown-body h2:first-child { margin-top: 0; }

/* Paragraphs & text */
.markdown-body p { margin: 0 0 1rem; }

/* Links */
.markdown-body a { color: var(--md-link); text-decoration: none; }
.markdown-body a:hover { color: var(--md-link-hover); text-decoration: underline; }

/* Inline code */
.markdown-body code {
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  font-size: 0.875em;
  padding: 0.2em 0.4em;
  background: var(--md-code-bg);
  color: var(--md-code-text);
  border: 1px solid var(--md-code-border);
  border-radius: 4px;
}

/* Code blocks */
.markdown-body pre {
  background: var(--md-pre-bg);
  color: var(--md-pre-text);
  border: 1px solid var(--md-code-border);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  overflow-x: auto;
  margin: 0 0 1rem;
  line-height: 1.6;
}
.markdown-body pre code {
  background: none;
  border: none;
  padding: 0;
  font-size: 0.875rem;
  color: inherit;
}

/* Blockquotes */
.markdown-body blockquote {
  margin: 0 0 1rem;
  padding: 0.5rem 1rem;
  border-left: 4px solid var(--md-blockquote-border);
  color: var(--md-blockquote-text);
}
.markdown-body blockquote > :last-child { margin-bottom: 0; }

/* Lists */
.markdown-body ul,
.markdown-body ol {
  margin: 0 0 1rem;
  padding-left: 2rem;
}
.markdown-body li { margin: 0.25rem 0; }
.markdown-body li > ul,
.markdown-body li > ol { margin-bottom: 0; }

/* Task lists */
.markdown-body ul.contains-task-list { list-style: none; padding-left: 0.5rem; }
.markdown-body .task-list-item { display: flex; align-items: flex-start; gap: 0.5rem; }
.markdown-body .task-list-item input[type="checkbox"] { margin-top: 0.3rem; flex-shrink: 0; }

/* Tables */
.markdown-body table {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 1rem;
  overflow: auto;
  display: block;
}
.markdown-body table th,
.markdown-body table td {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--md-table-border);
  text-align: left;
}
.markdown-body table th {
  font-weight: 600;
  background: var(--md-table-header-bg);
}
.markdown-body table tr:nth-child(even) { background: var(--md-table-stripe); }

/* Horizontal rules */
.markdown-body hr {
  height: 1px;
  background: var(--md-hr);
  border: none;
  margin: 1.5rem 0;
}

/* Images */
.markdown-body img {
  max-width: 100%;
  border-radius: 4px;
}

/* Keyboard */
.markdown-body kbd {
  font-family: ui-monospace, monospace;
  font-size: 0.8em;
  padding: 0.15em 0.4em;
  background: var(--md-surface);
  border: 1px solid var(--md-border);
  border-radius: 4px;
  box-shadow: 0 1px 0 var(--md-border);
}

/* Theme toolbar — collapses to icon badge, expands on hover */
#theme-toolbar {
  position: fixed;
  top: 14px;
  right: 16px;
  z-index: 9999;
  display: flex;
  align-items: center;
  padding: 5px 8px;
  background: #1e1e2e;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 20px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  transition: border-radius 0.2s ease, box-shadow 0.2s ease;
}
#theme-toolbar:hover {
  border-radius: 10px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.45);
  cursor: default;
}
.tb-icon {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1;
  flex-shrink: 0;
  display: inline-block;
  overflow: hidden;
  max-width: 2em;
  opacity: 1;
  color: rgba(255, 255, 255, 0.4);
  transition: max-width 0.2s ease, opacity 0.15s ease;
}
#theme-toolbar:hover .tb-icon {
  max-width: 0;
  opacity: 0;
}
.tb-content {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 0;
  overflow: hidden;
  opacity: 0;
  white-space: nowrap;
  transition: max-width 0.25s ease, opacity 0.2s ease 0.05s;
}
#theme-toolbar:hover .tb-content {
  max-width: 400px;
  opacity: 1;
}
#theme-toolbar .tb-label {
  font-size: 0.7rem;
  color: rgba(255, 255, 255, 0.45);
  margin-right: 2px;
  white-space: nowrap;
  user-select: none;
}
.tb-btn {
  padding: 3px 9px;
  font-size: 0.72rem;
  font-family: inherit;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  white-space: nowrap;
}
.tb-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.9);
  border-color: rgba(255, 255, 255, 0.15);
}
.tb-btn.active {
  background: rgba(167, 139, 250, 0.25);
  color: #c4b5fd;
  border-color: rgba(167, 139, 250, 0.4);
  font-weight: 600;
}
`

/** Inline script for theme persistence and switcher interactivity. */
const THEME_SCRIPT = `
(function() {
  var THEMES = ['github','dracula','solarized','nord'];
  var STORAGE_KEY = 'jolt-md-theme';

  function applyTheme(t) {
    if (THEMES.indexOf(t) === -1) t = 'github';
    document.documentElement.setAttribute('data-theme', t);
    var btns = document.querySelectorAll('.tb-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].dataset.theme === t);
    }
  }

  // Apply saved theme immediately (before paint)
  var saved = '';
  try { saved = localStorage.getItem(STORAGE_KEY) || ''; } catch(e) {}
  applyTheme(saved || 'github');

  document.addEventListener('DOMContentLoaded', function() {
    applyTheme(saved || 'github');
    var btns = document.querySelectorAll('.tb-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function() {
        var t = this.dataset.theme;
        try { localStorage.setItem(STORAGE_KEY, t); } catch(e) {}
        applyTheme(t);
      });
    }
  });
})();
`

function buildToolbar(): string {
  const buttons = THEMES.map(
    (t) => `<button class="tb-btn" data-theme="${t}" aria-label="Switch to ${THEME_LABELS[t]} theme">${THEME_LABELS[t]}</button>`
  ).join('\n      ')
  return `<div id="theme-toolbar" role="toolbar" aria-label="Theme switcher">
  <span class="tb-icon" aria-hidden="true">Aa</span>
  <span class="tb-content">
    <span class="tb-label">Theme</span>
    ${buttons}
  </span>
</div>`
}

/**
 * Renders a Markdown string into a complete, self-contained HTML page
 * with an embedded theme switcher toolbar.
 */
export function renderMarkdownPage(markdownSource: string): string {
  const renderedBody = marked.parse(markdownSource) as string
  const toolbar = buildToolbar()

  return `<!DOCTYPE html>
<html lang="en" data-theme="github">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Markdown</title>
  <style>
${THEME_CSS}
${BASE_CSS}
  </style>
  <script>${THEME_SCRIPT}<\/script>
</head>
<body>
${toolbar}
<div class="markdown-body">
${renderedBody}
</div>
</body>
</html>`
}
