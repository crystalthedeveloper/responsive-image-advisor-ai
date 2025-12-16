const MESSAGE_TYPE = 'element-selected';
const SUBSCRIBE_MESSAGE = 'riaa:selection:subscribe';
const REQUEST_MESSAGE = 'riaa:selection:request';
const PANEL_RESIZE_MESSAGE = 'riaa:panel:resize';
const DEV_HOST_REGEX = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/i;
const DEV_ENVIRONMENT =
  typeof window.__DEV_MODE_ === 'boolean'
    ? window.__DEV_MODE_
    : !window.location?.hostname || DEV_HOST_REGEX.test(window.location.hostname);
const RUNTIME_WAIT_TIMEOUT = 5000;
const MEDIA_SELECTOR =
  'img, picture, video, canvas, figure, svg, [data-wf-element-type="background-video"], [data-wf-element-type="video"]';
const MEDIA_TAGS = new Set(['img', 'picture', 'video', 'canvas', 'figure', 'svg']);
const subscribers = new Set();
let latestSelectionState = createEmptySelectionState();
const CONTEXT_READY_EVENT = 'riaa:context-ready';
const runtimePromise = waitForRuntime();
const SELECTION_EVENT_NAMES = ['selectedelementchange', 'selectedelementchanged', 'selectionchange', 'selectionchanged'];
const SELECTION_POLL_INTERVAL = 1500;
let selectionPollTimer = null;
let lastPolledSignature = null;
let devMockActive = false;
let designerScriptSupported = false;

probeDesignerScriptSupport();
if (!designerScriptSupported && DEV_ENVIRONMENT) {
  maybeActivateDevMock('designerscript-unavailable');
}

function initSelectionBridge() {
  window.addEventListener('message', handlePanelMessage);

  runtimePromise.then((runtime) => {
    if (runtime?.designerScript || runtime?.designerscript) {
      designerScriptSupported = true;
    }
    if (!designerScriptSupported && DEV_ENVIRONMENT) {
      maybeActivateDevMock('designerscript-unavailable');
    }
    if (!runtime) {
      console.warn('Webflow APIs are unavailable in this context.');
      if (DEV_ENVIRONMENT) {
        maybeActivateDevMock('runtime-unavailable');
      }
      return;
    }

    const ready = typeof runtime.ready === 'function' ? runtime.ready : (cb) => cb();
    ready(() => {
      subscribeToSelectionEvents(runtime);
      fetchAndBroadcastSelection();
      startSelectionPolling(runtime);
    });
  });
}

function handleSelectionChange(payload) {
  const state = normalizeSelectionState(payload);
  console.log('[RIAA] Webflow event fired with selection payload:', payload);
  console.log('[RIAA] Normalized selection state:', state);
  if (!state.devMock) {
    devMockActive = false;
    designerScriptSupported = true;
  }
  broadcastSelection(state);
}

function handleSelectionEvent(eventName, payload) {
  console.log(`[RIAA] Selection event received (${eventName})`, payload);
  handleSelectionChange(payload);
}

function postToPanel(target, selectionState) {
  console.log('[RIAA] Posting selection to panel:', selectionState);
  try {
    target.postMessage(
      {
        type: MESSAGE_TYPE,
        selection: selectionState,
        element: selectionState?.primary ?? null
      },
      '*'
    );
  } catch (error) {
    console.warn('Unable to message extension panel window.', error);
  }
}

function broadcastSelection(selectionState) {
  const payload = selectionState ?? createEmptySelectionState();
  if (typeof payload.devMock !== 'boolean') {
    payload.devMock = false;
  }
  console.log('[RIAA] Broadcasting selection to subscribers:', payload);
  latestSelectionState = payload;
  subscribers.forEach((subscriber) => {
    try {
      postToPanel(subscriber, payload);
    } catch (error) {
      console.warn('Unable to notify subscriber, removing from list.', error);
      subscribers.delete(subscriber);
    }
  });

  postToHostFrames(payload);
}

async function handlePanelMessage(event) {
  const type = event.data?.type;
  console.log('[RIAA] Panel message received:', type, event.data);
  if (type === CONTEXT_READY_EVENT) {
    console.log('[RIAA] Panel context ready notice received.');
    registerSubscriber(event);
    if (!latestSelectionState?.primary && !latestSelectionState?.elements?.length) {
      const selection = await fetchCurrentSelection();
      broadcastSelection(selection);
    } else {
      broadcastSelection(latestSelectionState);
    }
    return;
  }

  if (type === PANEL_RESIZE_MESSAGE) {
    handlePanelResizeRequest(event.data?.size);
    return;
  }

  if (type !== SUBSCRIBE_MESSAGE && type !== REQUEST_MESSAGE) return;

  const source = registerSubscriber(event);
  if (!source) return;

  const payload = latestSelectionState?.primary || latestSelectionState?.elements?.length
    ? latestSelectionState
    : await fetchCurrentSelection();
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
    window.parent?.postMessage(
      { type: MESSAGE_TYPE, selection, element: selection?.primary ?? null },
      '*'
    );
    if (window.top && window.top !== window.parent) {
      window.top.postMessage({ type: MESSAGE_TYPE, selection, element: selection?.primary ?? null }, '*');
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

function normalizeSelectionState(payload) {
  if (payload && payload.devMock) {
    return {
      elements: payload.elements || [],
      primary: payload.primary || null,
      devMock: true
    };
  }
  const selectionArray = extractSelectionArray(payload);
  if (!selectionArray.length) {
    return createEmptySelectionState();
  }

  const normalizedElements = selectionArray
    .map((item) => normalizeSelection(item))
    .filter((entry) => Boolean(entry));
  if (!normalizedElements.length) {
    return createEmptySelectionState();
  }

  return {
    elements: normalizedElements,
    primary: normalizedElements[0] ?? null,
    devMock: false
  };
}

function extractSelectionArray(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.selectedElements)) return payload.selectedElements;
  if (Array.isArray(payload.elements)) return payload.elements;
  if (Array.isArray(payload.selection)) return payload.selection;
  if (payload.selectedElement) return [payload.selectedElement];
  if (payload.element) return [payload.element];
  return [payload];
}

function createEmptySelectionState() {
  return { elements: [], primary: null, devMock: false };
}

function createDevSelectionState(reason) {
  const mockElement = {
    id: 'riaa-dev-mock',
    label: 'DEV Mock Image',
    tagName: 'img',
    selector: '.riaa-dev-mock',
    widths: {
      desktop: 640,
      mobile: 320
    },
    computedWidths: {
      desktop: 640,
      mobile: 320
    },
    computedWidthDesktop: 640,
    computedWidthMobile: 320,
    devMock: true,
    reason
  };
  return { elements: [mockElement], primary: mockElement, devMock: true, reason };
}

function maybeActivateDevMock(reason) {
  if (!DEV_ENVIRONMENT) return;
  if (devMockActive && latestSelectionState?.devMock) return;
  devMockActive = true;
  const payload = createDevSelectionState(reason);
  payload.devMockReason = reason ?? null;
  broadcastSelection(payload);
}

function probeDesignerScriptSupport() {
  try {
    const wf = window.Webflow;
    if (!wf) return false;
    if (typeof wf.require === 'function') {
      const module = wf.require('designerscript');
      if (module) {
        designerScriptSupported = true;
        return true;
      }
    }
    if (Array.isArray(wf)) {
      wf.push(() => {
        try {
          const runtime = window.Webflow;
          if (typeof runtime?.require === 'function') {
            const module = runtime.require('designerscript');
            if (module) {
              designerScriptSupported = true;
            }
          }
        } catch (error) {
          console.warn('Unable to detect DesignerScript via Webflow queue.', error);
        }
      });
    }
  } catch (error) {
    console.warn('DesignerScript detection failed.', error);
  }
  return designerScriptSupported;
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

function handlePanelResizeRequest(size) {
  const normalized = sanitizePanelSize(size);
  if (!normalized) return;
  runtimePromise.then((runtime) => {
    if (!runtime) {
      console.warn('[RIAA] Unable to resize panel; runtime unavailable.');
      return;
    }
    requestExtensionPanelSize(runtime, normalized);
  });
}

function sanitizePanelSize(size) {
  if (!size || typeof size !== 'object') return null;
  const width = toPositiveNumber(size.width);
  const height = toPositiveNumber(size.height);
  if (!width || !height) return null;
  return { width, height };
}

function requestExtensionPanelSize(runtime, size) {
  if (!runtime || !size) return;
  try {
    if (typeof runtime.setExtensionSize === 'function') {
      const result = runtime.setExtensionSize(size);
      if (result && typeof result.then === 'function') {
        result.catch(() => {});
      }
      return;
    }
    if (typeof runtime.resize === 'function') {
      runtime.resize(size);
    }
  } catch (error) {
    console.warn('[RIAA] Unable to request panel resize.', error);
  }
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
        window.clearTimeout(timeout);
        resolve(runtime);
      }
    }, 50);

    const timeout = window.setTimeout(() => {
      window.clearInterval(timer);
      resolve(null);
    }, RUNTIME_WAIT_TIMEOUT);
  });
}

function getRuntime() {
  return window.webflow || window.Webflow || null;
}

async function fetchCurrentSelection() {
  try {
    const runtime = await runtimePromise;
    if (!runtime) {
      if (DEV_ENVIRONMENT) {
        maybeActivateDevMock('runtime-missing');
        return createDevSelectionState();
      }
      return createEmptySelectionState();
    }
    if (typeof runtime.getSelectedElements === 'function') {
      const selectionArray = await runtime.getSelectedElements();
      console.log('[RIAA] getSelectedElements() returned:', selectionArray);
      return normalizeSelectionState(selectionArray || []);
    }
    if (typeof runtime.getSelectedElement === 'function') {
      const selection = await runtime.getSelectedElement();
      console.log('[RIAA] getSelectedElement() returned:', selection);
      return normalizeSelectionState(selection ?? null);
    }
    if (DEV_ENVIRONMENT) {
      maybeActivateDevMock('runtime-incomplete');
      return createDevSelectionState();
    }
    return createEmptySelectionState();
  } catch (error) {
    console.warn('Unable to fetch current selection from Webflow.', error);
    if (DEV_ENVIRONMENT) {
      maybeActivateDevMock('runtime-error');
      return createDevSelectionState();
    }
    return createEmptySelectionState();
  }
}

async function fetchAndBroadcastSelection() {
  const selection = await fetchCurrentSelection();
  broadcastSelection(selection);
}

function subscribeToSelectionEvents(runtime) {
  const attach = (label, handler) => {
    if (typeof handler !== 'function') return;
    SELECTION_EVENT_NAMES.forEach((eventName) => {
      try {
        handler.call(runtime, eventName, (payload) => handleSelectionEvent(eventName, payload));
      } catch (error) {
        console.warn(`[RIAA] Unable to attach ${label} listener for ${eventName}`, error);
      }
    });
  };

  if (typeof runtime.subscribe !== 'function' && typeof runtime.on !== 'function') {
    console.warn('[RIAA] Webflow runtime lacks subscribe/on APIs; relying on polling.');
  }

  attach('subscribe', runtime.subscribe);
  attach('on', runtime.on);
}

function startSelectionPolling(runtime) {
  if (selectionPollTimer) return;
  const hasElementsApi =
    typeof runtime?.getSelectedElements === 'function' || typeof runtime?.getSelectedElement === 'function';
  if (!hasElementsApi) return;

  selectionPollTimer = window.setInterval(async () => {
    try {
      let rawSelection = null;
      if (typeof runtime.getSelectedElements === 'function') {
        rawSelection = await runtime.getSelectedElements();
      } else if (typeof runtime.getSelectedElement === 'function') {
        rawSelection = await runtime.getSelectedElement();
      }
      const normalized = normalizeSelectionState(rawSelection || []);
      const signature = serializeSelectionState(normalized);
      if (signature !== lastPolledSignature) {
        lastPolledSignature = signature;
        broadcastSelection(normalized);
      }
    } catch (error) {
      console.warn('[RIAA] Selection polling failed.', error);
    }
  }, SELECTION_POLL_INTERVAL);
}

function serializeSelectionState(state) {
  if (!state) return 'null';
  try {
    return JSON.stringify({
      count: state.elements?.length ?? 0,
      ids: (state.elements || []).map((element) => element.id ?? element.elementId ?? element.selector ?? null),
      selector: state.primary?.selector ?? null,
      tagName: state.primary?.tagName ?? null,
      devMock: Boolean(state.devMock)
    });
  } catch (error) {
    console.warn('[RIAA] Unable to serialize selection state.', error);
    return String(Math.random());
  }
}

initSelectionBridge();
