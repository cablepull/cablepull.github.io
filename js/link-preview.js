/**
 * Hover link previews via Microlink API (https://microlink.io).
 *
 * Optional: <body data-link-preview="off"> to disable.
 * Optional: data-link-preview-root=".prose,.sources-wrap" (comma-separated; default includes .outbound).
 */

const MICROLINK_API = "https://api.microlink.io/";
const HOVER_DELAY_MS = 380;
const CACHE_TTL_MS = 45 * 60 * 1000;
const cache = new Map();

let popoverEl;
let showTimer = 0;
let activeAbort = null;
let lastPointer = { x: 0, y: 0 };
let currentAnchor = null;

function getSelectorList() {
  const raw = document.body?.getAttribute("data-link-preview-root");
  if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return [".prose", ".sources-wrap", ".outbound"];
}

function isPreviewableLink(anchor) {
  if (!anchor || anchor.tagName !== "A") return false;
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#")) return false;
  try {
    const u = new URL(href, window.location.href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.origin === window.location.origin) return false;
  } catch {
    return false;
  }
  return true;
}

function anchorInScope(anchor, selectorList) {
  return selectorList.some((sel) => anchor.closest(sel));
}

function ensurePopover() {
  if (popoverEl) return popoverEl;
  popoverEl = document.createElement("div");
  popoverEl.className = "link-preview-popover";
  popoverEl.setAttribute("role", "tooltip");
  popoverEl.innerHTML = `
    <div class="link-preview-popover__inner">
      <div class="link-preview-popover__loading">Loading preview…</div>
      <div class="link-preview-popover__content" hidden>
        <img class="link-preview-popover__img" alt="" width="1200" height="630" decoding="async" hidden />
        <div class="link-preview-popover__text">
          <div class="link-preview-popover__title"></div>
          <div class="link-preview-popover__desc"></div>
          <div class="link-preview-popover__host"></div>
        </div>
      </div>
      <div class="link-preview-popover__error" hidden></div>
    </div>
  `;
  document.body.appendChild(popoverEl);
  return popoverEl;
}

function positionPopover(x, y) {
  if (!popoverEl) return;
  const pad = 12;
  const w = popoverEl.offsetWidth || 300;
  const h = popoverEl.offsetHeight || 160;
  let left = x + pad;
  let top = y + pad;
  if (left + w > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - w - pad);
  if (top + h > window.innerHeight - pad) top = Math.max(pad, y - h - pad);
  popoverEl.style.left = `${left}px`;
  popoverEl.style.top = `${top}px`;
}

function hidePopover() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = 0;
  }
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  currentAnchor = null;
  if (popoverEl) {
    popoverEl.classList.remove("is-visible");
    popoverEl.setAttribute("aria-hidden", "true");
  }
}

async function fetchPreview(url, signal) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.t < CACHE_TTL_MS) return cached.data;

  const apiUrl = `${MICROLINK_API}?url=${encodeURIComponent(url)}`;
  const res = await fetch(apiUrl, { signal, credentials: "omit" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === "fail") {
    const msg = json.data?.message || json.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const data = json.data || {};
  cache.set(url, { data, t: Date.now() });
  return data;
}

function fillPopover(data, fallbackUrl) {
  const el = ensurePopover();
  const loading = el.querySelector(".link-preview-popover__loading");
  const content = el.querySelector(".link-preview-popover__content");
  const err = el.querySelector(".link-preview-popover__error");
  const img = el.querySelector(".link-preview-popover__img");
  const title = el.querySelector(".link-preview-popover__title");
  const desc = el.querySelector(".link-preview-popover__desc");
  const host = el.querySelector(".link-preview-popover__host");

  loading.hidden = true;
  err.hidden = true;
  content.hidden = false;

  const imageUrl = data.image?.url || data.logo?.url;
  if (imageUrl) {
    img.src = imageUrl;
    img.hidden = false;
    img.alt = data.title || "";
  } else {
    img.removeAttribute("src");
    img.hidden = true;
  }

  title.textContent = data.title || new URL(fallbackUrl).hostname;
  desc.textContent = data.description || "";
  desc.hidden = !data.description;
  try {
    host.textContent = new URL(fallbackUrl).hostname;
  } catch {
    host.textContent = fallbackUrl;
  }
}

function showError(message, url) {
  const el = ensurePopover();
  const loading = el.querySelector(".link-preview-popover__loading");
  if (loading) loading.hidden = true;
  el.querySelector(".link-preview-popover__content").hidden = true;
  const err = el.querySelector(".link-preview-popover__error");
  err.hidden = false;
  err.replaceChildren();
  err.appendChild(document.createTextNode(message));
  err.appendChild(document.createElement("br"));
  const small = document.createElement("small");
  try {
    small.textContent = new URL(url).hostname;
  } catch {
    small.textContent = url;
  }
  err.appendChild(small);
}

function scheduleShow(anchor, x, y) {
  const url = anchor.href;
  if (showTimer) clearTimeout(showTimer);
  if (activeAbort) activeAbort.abort();

  lastPointer = { x, y };

  const el = ensurePopover();
  const loadEl = el.querySelector(".link-preview-popover__loading");
  if (loadEl) loadEl.hidden = false;
  el.querySelector(".link-preview-popover__content").hidden = true;
  el.querySelector(".link-preview-popover__error").hidden = true;
  el.classList.add("is-visible");
  el.setAttribute("aria-hidden", "false");
  positionPopover(x, y);

  activeAbort = new AbortController();
  const { signal } = activeAbort;

  showTimer = window.setTimeout(async () => {
    showTimer = 0;
    try {
      const data = await fetchPreview(url, signal);
      if (signal.aborted) return;
      fillPopover(data, url);
      positionPopover(lastPointer.x, lastPointer.y);
    } catch (e) {
      if (signal.aborted || e.name === "AbortError") return;
      showError("Preview unavailable (network, CORS, or rate limit).", url);
      positionPopover(lastPointer.x, lastPointer.y);
    }
  }, HOVER_DELAY_MS);
}

function init() {
  if (document.body?.getAttribute("data-link-preview") === "off") return;

  const container = document.querySelector(".page-main") || document.body;
  const selectorList = getSelectorList();

  container.addEventListener("mouseover", (e) => {
    const a = e.target.closest?.("a");
    if (!a || !isPreviewableLink(a) || !anchorInScope(a, selectorList)) return;
    if (a === currentAnchor) return;
    currentAnchor = a;
    scheduleShow(a, e.clientX, e.clientY);
  });

  container.addEventListener("mousemove", (e) => {
    if (!currentAnchor) return;
    const a = e.target.closest?.("a");
    if (a !== currentAnchor) return;
    lastPointer = { x: e.clientX, y: e.clientY };
    if (popoverEl?.classList.contains("is-visible")) positionPopover(e.clientX, e.clientY);
  });

  container.addEventListener("mouseout", (e) => {
    if (!currentAnchor) return;
    const a = e.target.closest?.("a");
    if (a !== currentAnchor) return;
    const rel = e.relatedTarget;
    if (rel && currentAnchor.contains(rel)) return;
    hidePopover();
  });

  document.addEventListener("scroll", () => hidePopover(), true);
  window.addEventListener("blur", hidePopover);
}

init();
