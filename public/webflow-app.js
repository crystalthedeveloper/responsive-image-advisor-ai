const MESSAGE_TYPE = 'element-selected';
const SUBSCRIBE_MESSAGE = 'riaa:selection:subscribe';
const REQUEST_MESSAGE = 'riaa:selection:request';
const MEDIA_SELECTOR =
  'img, picture, video, canvas, figure, svg, [data-wf-element-type="background-video"], [data-wf-element-type="video"]';
const MEDIA_TAGS = new Set(['img', 'picture', 'video', 'canvas', 'figure', 'svg']);
const subscribers = new Set();
let latestSelection = null;
const CONTEXT_READY_EVENT = 'riaa:context-ready';
const runtimePromise = waitForRuntime();

function initSelectionBridge() {
  window.addEventListener('message', handlePanelMessage);

  runtimePromise.then((runtime) => {
    if (!runtime) {
      console.warn('Webflow APIs are unavailable in this context.');
      return;
    }

    const ready = typeof runtime.ready === 'function' ? runtime.ready : (cb) => cb();
    ready(() => {
      if (typeof runtime.subscribe === 'function') {
        runtime.subscribe('selectedelementchange', handleSelectionChange);
      } else if (typeof runtime.on === 'function') {
        runtime.on('selectedelementchange', handleSelectionChange);
      } else {
        console.warn('webflow.on is unavailable; selection updates will be limited.');
      }
      fetchAndBroadcastSelection();
    });
  });
}

function handleSelectionChange(payload) {
  const selectedElement =
    (payload && typeof payload === 'object' && 'selectedElement' in payload ? payload.selectedElement : payload) ||
    null;
  console.log('[RIAA] Webflow event fired with selection:', selectedElement);
  const normalized = normalizeSelection(selectedElement);
  console.log('[RIAA] Normalized selection from event:', normalized);
  broadcastSelection(normalized);
}

function postToPanel(target, selection) {
  console.log('[RIAA] Posting selection to panel:', selection);
  try {
    target.postMessage({ type: MESSAGE_TYPE, element: selection }, '*');
  } catch (error) {
    console.warn('Unable to message extension panel window.', error);
  }
}

function broadcastSelection(selection) {
  console.log('[RIAA] Broadcasting selection to subscribers:', selection);
  latestSelection = selection;
  subscribers.forEach((subscriber) => {
    try {
      postToPanel(subscriber, selection);
    } catch (error) {
      console.warn('Unable to notify subscriber, removing from list.', error);
      subscribers.delete(subscriber);
    }
  });

  postToHostFrames(selection);
}

async function handlePanelMessage(event) {
  const type = event.data?.type;
  console.log('[RIAA] Panel message received:', type, event.data);
  if (type === CONTEXT_READY_EVENT) {
    console.log('[RIAA] Panel context ready notice received.');
    registerSubscriber(event);
    if (latestSelection) {
      broadcastSelection(latestSelection);
    } else {
      const selection = await fetchCurrentSelection();
      broadcastSelection(selection);
    }
    return;
  }

  if (type !== SUBSCRIBE_MESSAGE && type !== REQUEST_MESSAGE) return;

  const source = registerSubscriber(event);
  if (!source) return;

  const payload = latestSelection ?? (await fetchCurrentSelection());
  console.log('[RIAA] Responding to panel with payload:', payload);
  try {
    postToPanel(source, payload ?? null);
  } catch (error) {
    console.warn('Unable to respond to panel request.', error);
  }
}

function registerSubscriber(event) {
  const source = event.source;
  if (!source || typeof source.postMessage !== 'function') return null;
  subscribers.add(source);
  console.log('[RIAA] Subscriber count:', subscribers.size);
  return source;
}

function postToHostFrames(selection) {
  try {
    window.parent?.postMessage({ type: MESSAGE_TYPE, element: selection }, '*');
    if (window.top && window.top !== window.parent) {
      window.top.postMessage({ type: MESSAGE_TYPE, element: selection }, '*');
    }
  } catch (error) {
    console.warn('Unable to broadcast selection to host frames.', error);
  }
}

function normalizeSelection(selectedElement) {
  if (!selectedElement) {
    console.log('[RIAA] normalizeSelection called with null selection.');
    return null;
  }

  const safeBase = createSerializableSelection(selectedElement);
  const domNode = resolveDomNode(selectedElement);
  console.log('[RIAA] Resolved DOM node:', domNode);
  const visualNode = findVisualMediaNode(domNode);
  console.log('[RIAA] Visual node determined as:', visualNode);
  const measurementNode = visualNode || domNode;
  const computedWidths = computeBoundingWidths(measurementNode);
  console.log('[RIAA] Computed widths:', computedWidths);
  const tagName = (visualNode || domNode)?.tagName?.toLowerCase() ?? safeBase.tagName ?? null;
  const id = (visualNode || domNode)?.id || safeBase.id || null;
  const selector = buildSelector(visualNode || domNode, safeBase.selector);

  return {
    ...safeBase,
    tagName,
    id,
    selector,
    computedWidths,
    computedWidthDesktop: computedWidths.desktop,
    computedWidthMobile: computedWidths.mobile
  };
}

function resolveDomNode(selectedElement) {
  const candidates = [
    selectedElement?.domNode,
    selectedElement?.element,
    selectedElement?.el,
    selectedElement?.node,
    selectedElement?.target
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate.getBoundingClientRect === 'function') {
      return candidate;
    }
  }

  const selector = selectedElement?.selector;
  if (selector) {
    try {
      const match = document.querySelector(selector);
      if (match) return match;
    } catch (error) {
      console.warn('Unable to query selector from selected element.', error);
    }
  }

  if (selectedElement?.id) {
    const matchById = document.getElementById(selectedElement.id);
    if (matchById) return matchById;
  }

  return null;
}

function findVisualMediaNode(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
  if (isImageLikeElement(node)) return node;

  const backgroundTarget = hasBackgroundImage(node) ? node : null;
  if (backgroundTarget) return backgroundTarget;

  if (typeof node.querySelector === 'function') {
    const nestedMedia = node.querySelector(MEDIA_SELECTOR);
    if (nestedMedia) return nestedMedia;
  }

  return node;
}

function isImageLikeElement(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  const tagName = node.tagName?.toLowerCase();
  if (!tagName) return false;
  if (MEDIA_TAGS.has(tagName)) return true;
  return hasBackgroundImage(node);
}

function hasBackgroundImage(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  try {
    const styles = window.getComputedStyle(node);
    return Boolean(styles && styles.backgroundImage && styles.backgroundImage !== 'none');
  } catch (error) {
    console.warn('Unable to compute background styles for node.', error);
    return false;
  }
}

function computeBoundingWidths(node) {
  const fallback = { desktop: null, mobile: null };
  if (!node || typeof node.getBoundingClientRect !== 'function') {
    return fallback;
  }

  const rect = node.getBoundingClientRect();
  const width = toPositiveNumber(rect?.width);
  if (!width) {
    return fallback;
  }

  const device = getCurrentDevice();
  const measurements = { desktop: null, mobile: null };

  if (device === 'mobile') {
    measurements.mobile = width;
    measurements.desktop = width;
  } else {
    measurements.desktop = width;
    measurements.mobile = width;
  }

  return measurements;
}

function getCurrentDevice() {
  const runtime = getRuntime();
  const candidate =
    runtime?.breakpoint?.name || runtime?.breakpoint || runtime?.device || runtime?.context?.breakpoint;

  if (typeof candidate === 'string') {
    const value = candidate.toLowerCase();
    if (value.includes('mobile')) return 'mobile';
    if (value.includes('tablet')) return 'tablet';
  }

  return 'desktop';
}

function toPositiveNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return null;
}

function buildSelector(node, fallbackSelector) {
  if (fallbackSelector) return fallbackSelector;
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
  if (node.id) return `#${node.id}`;
  if (node.classList?.length) {
    const classes = Array.from(node.classList).join('.');
    return `${node.tagName.toLowerCase()}.${classes}`;
  }
  return node.tagName?.toLowerCase() ?? null;
}

function createSerializableSelection(source) {
  if (!source || typeof source !== 'object') {
    return {};
  }

  const safe = {
    id: source.id ?? source.elementId ?? null,
    elementId: source.elementId ?? source.id ?? null,
    label: source.label ?? source.name ?? null,
    selector: source.selector ?? null,
    tagName: source.tagName ?? null
  };

  const sanitizedWidths = sanitizeWidths(source.widths);
  if (sanitizedWidths) {
    safe.widths = sanitizedWidths;
  }

  return safe;
}

function sanitizeWidths(widths) {
  if (!widths || typeof widths !== 'object') return null;
  const sanitized = {};
  ['desktop', 'tablet', 'mobile'].forEach((key) => {
    const value = toPositiveNumber(widths[key]);
    if (value) {
      sanitized[key] = value;
    }
  });
  return Object.keys(sanitized).length ? sanitized : null;
}

function waitForRuntime() {
  return new Promise((resolve) => {
    const immediate = getRuntime();
    if (immediate) {
      resolve(immediate);
      return;
    }

    const timer = window.setInterval(() => {
      const runtime = getRuntime();
      if (runtime) {
        window.clearInterval(timer);
        resolve(runtime);
      }
    }, 50);
  });
}

function getRuntime() {
  return window.webflow || window.Webflow || null;
}

async function fetchCurrentSelection() {
  try {
    const runtime = await runtimePromise;
    if (!runtime || typeof runtime.getSelectedElement !== 'function') return null;
    const selection = await runtime.getSelectedElement();
    console.log('[RIAA] getSelectedElement() returned:', selection);
    return normalizeSelection(selection || null);
  } catch (error) {
    console.warn('Unable to fetch current selection from Webflow.', error);
    return null;
  }
}

async function fetchAndBroadcastSelection() {
  const selection = await fetchCurrentSelection();
  broadcastSelection(selection);
}

initSelectionBridge();
