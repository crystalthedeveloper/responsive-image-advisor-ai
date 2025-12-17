const ANALYZE_ENDPOINT = '/analyze';
const SELECTION_MESSAGE_TYPE = 'element-selected';
const SUBSCRIBE_MESSAGE_TYPE = 'riaa:selection:subscribe';
const REQUEST_MESSAGE_TYPE = 'riaa:selection:request';
const CONTEXT_READY_MESSAGE_TYPE = 'riaa:context-ready';
const PANEL_RESIZE_MESSAGE_TYPE = 'riaa:panel:resize';
const DEV_HOST_REGEX = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/i;
const DEV_ENVIRONMENT =
  typeof window.__DEV_MODE_ === 'boolean'
    ? window.__DEV_MODE_
    : !window.location?.hostname || DEV_HOST_REGEX.test(window.location.hostname);
const WEBFLOW_DOMAIN_SUFFIX = '.webflow.com';
const KNOWN_WEBFLOW_ORIGINS = ['https://webflow.com', 'https://app.webflow.com'];
const LOG_PREFIX = '[Responsive Image Advisor AI]';
const PANEL_WIDTH = 520;
const PANEL_HEIGHT = 720;
const RUNTIME_RETRY_DELAY = 300;
const RUNTIME_MAX_ATTEMPTS = 40;
const RUNTIME_TIMEOUT_MS = 15000;

let designerMessageWindow = window.parent && window.parent !== window ? window.parent : null;
const referrerOrigin = getDesignerOriginFromReferrer();
let trustedDesignerOrigin = referrerOrigin && isAllowedHostOrigin(referrerOrigin) ? referrerOrigin : null;
let designerOriginConfirmed = false;

const logDebug = (...args) => {
  if (DEV_ENVIRONMENT) console.debug(LOG_PREFIX, ...args);
};
const logWarn = (...args) => {
  if (DEV_ENVIRONMENT) console.warn(LOG_PREFIX, ...args);
};
const logError = (...args) => {
  if (DEV_ENVIRONMENT) console.error(LOG_PREFIX, ...args);
};

const getRuntimeCandidate = () => window.webflow || window.Webflow || null;

let runtimePromise = null;
const getRuntimeApi = () => {
  if (runtimePromise) return runtimePromise;

  runtimePromise = new Promise((resolve, reject) => {
    const immediate = getRuntimeCandidate();
    if (immediate) {
      resolve(immediate);
      return;
    }

    let attempts = 0;
    const startTime = Date.now();
    const timer = window.setInterval(() => {
      const candidate = getRuntimeCandidate();
      if (candidate) {
        window.clearInterval(timer);
        resolve(candidate);
        return;
      }

      attempts += 1;
      if (attempts >= RUNTIME_MAX_ATTEMPTS || Date.now() - startTime > RUNTIME_TIMEOUT_MS) {
        window.clearInterval(timer);
        reject(new Error('Designer runtime unavailable'));
      }
    }, RUNTIME_RETRY_DELAY);
  });

  return runtimePromise;
};

const requestPanelSize = (api, size) => {
  try {
    if (typeof api.setExtensionSize === 'function') {
      const result = api.setExtensionSize(size);
      if (result && typeof result.then === 'function') {
        result.catch(() => {});
      }
      return true;
    }
    if (typeof api.resize === 'function') {
      api.resize(size);
      return true;
    }
  } catch (error) {
    logWarn('Designer runtime rejected resize request.', error);
  }
  return false;
};

const ensureResize = () => {
  if (typeof window === 'undefined') return;
  const size = { width: PANEL_WIDTH, height: PANEL_HEIGHT };
  requestHostResize(size);

  getRuntimeApi()
    .then((api) => {
      requestPanelSize(api, size);
    })
    .catch((error) => logWarn('Designer runtime unavailable during resize.', error));

  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    getRuntimeApi()
      .then((api) => {
        if (requestPanelSize(api, size)) {
          window.clearInterval(timer);
        } else if (attempts >= RUNTIME_MAX_ATTEMPTS) {
          window.clearInterval(timer);
        }
      })
      .catch((error) => {
        logWarn('Retrying resize until runtime responds.', error);
        if (attempts >= RUNTIME_MAX_ATTEMPTS) {
          window.clearInterval(timer);
        }
      });
  }, RUNTIME_RETRY_DELAY);
};

ensureResize();

const ui = {
  analyzeButton: document.getElementById('analyze-button'),
  status: document.getElementById('status-message'),
  resultsCard: document.getElementById('results-card'),
  universalSize: document.getElementById('universal-size'),
  desktopSize: document.getElementById('desktop-size'),
  mobileSize: document.getElementById('mobile-size'),
  explanation: document.getElementById('analysis-explanation'),
  selectedLabel: document.getElementById('selected-element-text'),
  selectionDebug: document.getElementById('selection-debug'),
  devBadge: document.getElementById('dev-badge')
};

let currentSelectionState = null;
let currentSelected = null;
let devMockSelectionActive = false;
let analyzeProcessing = false;
let analyzeSelectionReady = false;

initPanel();

function initPanel() {
  ui.analyzeButton?.addEventListener('click', handleAnalyzeClick);

  window.addEventListener('message', handleSelectionMessage);
  setStatus('Waiting for a Designer selection...');
  setAnalyzeProcessing(false);
  setAnalyzeReady(false);
  updateDevBadge();
  if (DEV_ENVIRONMENT) {
    showDevMockSelection('dev-init');
  }
  requestSelectionUpdate(true);
  notifyContextReady();
}

async function handleAnalyzeClick() {
  if (!currentSelected) {
    hideResults();
    setStatus('Select an image in the Designer first.', 'warning');
    return;
  }

  setAnalyzeProcessing(true);
  setStatus('Checking selected element...');

  try {
    const measuredWidths = deriveMeasuredWidths(currentSelected);
    if (!measuredWidths) {
      throw new Error('Unable to determine rendered widths for the selected element.');
    }

    setStatus('Sending widths to AI backend...');
    const recommendations = await requestRecommendations({
      element: {
        label: currentSelected.label ?? 'Selected element',
        tagName: currentSelected.tagName ?? null,
        selector: currentSelected.selector ?? null
      },
      widths: measuredWidths,
      metadata: {
        source: getWidthSource(currentSelected),
        computedWidths: currentSelected.computedWidths ?? null
      }
    });

    renderResults(recommendations, measuredWidths);
    setStatus('Analysis complete.');
  } catch (error) {
    logError('Analysis failed', error);
    hideResults();
    setStatus(error.message || 'Unable to analyze the selected element.', 'error');
  } finally {
    setAnalyzeProcessing(false);
  }
}

function handleSelectionMessage(event) {
  const isMessageEvent = event && typeof event === 'object' && 'data' in event && 'origin' in event;
  if (isMessageEvent) {
    if (!isTrustedDesignerMessage(event)) return;
    const message = event.data;
    if (message?.type !== SELECTION_MESSAGE_TYPE) return;
    applySelectionState(message.selection || message.element || null);
    return;
  }
  if (event?.type !== SELECTION_MESSAGE_TYPE) return;
  applySelectionState(event.selection || event.element || null);
}

function applySelectionState(payload) {
  const nextState = normalizeIncomingSelection(payload);
  currentSelectionState = nextState;
  currentSelected = nextState?.primary ?? null;
  devMockSelectionActive = Boolean(nextState?.devMock);
  updateDevBadge();
  updateSelectionUI();
}

function updateSelectionUI() {
  const hasSelection = Boolean(currentSelected);
  const isDevMock = Boolean(currentSelectionState?.devMock);
  setAnalyzeReady(hasSelection);

  if (!hasSelection) {
    updateSelectedLabel('Waiting for a Designer selection...');
    updateSelectionDebug(null);
    hideResults();
    setStatus('Waiting for a Designer selection...', 'info');
    return;
  }

  updateSelectedLabel(currentSelected);
  updateSelectionDebug(currentSelected);

  const measuredWidths = deriveMeasuredWidths(currentSelected);
  if (!measuredWidths) {
    setStatus('Waiting for rendered widths from the Designer runtime...', 'warning');
    return;
  }

  if (isDevMock) {
    hideResults();
    setStatus('DEV Mock Mode Active. Click Analyze to simulate results.', 'info');
    return;
  }

  if (currentSelected.widths) {
    setStatus('Ready to analyze.');
  } else {
    setStatus('Ready (using measured width from Designer viewport).');
  }
}

async function requestRecommendations(payload) {
  try {
    const response = await fetch(ANALYZE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error('The AI backend returned an error.');
    }

    return response.json();
  } catch (error) {
    if (DEV_ENVIRONMENT) {
      logWarn('Falling back to mock recommendations in dev mode.', error);
      return buildMockRecommendations(payload?.widths);
    }
    throw error;
  }
}

function renderResults(recommendations, measuredWidths) {
  const desktopMeasured = toFiniteNumber(measuredWidths?.desktop) ?? toFiniteNumber(measuredWidths?.mobile);
  const mobileMeasured = toFiniteNumber(measuredWidths?.mobile) ?? desktopMeasured;

  const universalFallback = desktopMeasured ? desktopMeasured * 2 : mobileMeasured ? mobileMeasured * 2 : null;
  const universal = recommendations?.universalUploadSize ?? universalFallback;
  const desktop = recommendations?.desktopRenderSize ?? desktopMeasured;
  const mobile = recommendations?.mobileRenderSize ?? mobileMeasured;
  const explanation =
    recommendations?.explanation ??
    'We doubled the largest rendered width to create a single upload that remains sharp across all breakpoints.';

  ui.universalSize.textContent = formatPixelValue(universal);
  ui.desktopSize.textContent = formatPixelValue(desktop);
  ui.mobileSize.textContent = formatPixelValue(mobile);
  ui.explanation.textContent = explanation;

  ui.resultsCard?.classList.remove('hidden');
}

function hideResults() {
  ui.resultsCard?.classList.add('hidden');
}

function formatPixelValue(value) {
  return Number.isFinite(value) ? `${Math.round(value)}px` : '--';
}

function buildMockRecommendations(measuredWidths) {
  const desktopMeasured = toFiniteNumber(measuredWidths?.desktop) ?? 640;
  const mobileMeasured = toFiniteNumber(measuredWidths?.mobile) ?? Math.round(desktopMeasured * 0.6);
  const universal = Math.round(Math.max(desktopMeasured, mobileMeasured) * 2);
  return {
    universalUploadSize: universal,
    desktopRenderSize: desktopMeasured,
    mobileRenderSize: mobileMeasured,
    explanation:
      'DEV mock response: doubled the largest measured width to simulate the AI backend while offline.'
  };
}

function deriveMeasuredWidths(selection) {
  if (!selection) return null;

  if (selection.widths && (selection.widths.desktop || selection.widths.mobile)) {
    return {
      desktop: toFiniteNumber(selection.widths.desktop) ?? toFiniteNumber(selection.widths.mobile),
      mobile: toFiniteNumber(selection.widths.mobile) ?? toFiniteNumber(selection.widths.desktop)
    };
  }

  const computedDesktop = toFiniteNumber(selection.computedWidthDesktop) ?? toFiniteNumber(selection.computedWidths?.desktop);
  const computedMobile = toFiniteNumber(selection.computedWidthMobile) ?? toFiniteNumber(selection.computedWidths?.mobile);

  if (!computedDesktop && !computedMobile) {
    return null;
  }

  return {
    desktop: computedDesktop ?? computedMobile ?? null,
    mobile: computedMobile ?? computedDesktop ?? null
  };
}

function getWidthSource(selection) {
  if (selection?.widths) return 'designer';
  if (selection?.computedWidths) return 'computed';
  return 'unknown';
}

function normalizeIncomingSelection(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) {
    return {
      elements: payload.filter(Boolean),
      primary: payload.find(Boolean) ?? null,
      devMock: Boolean(payload.find((item) => item?.devMock)),
      reason: null
    };
  }
  if (payload.elements && payload.primary) {
    const elements = Array.isArray(payload.elements) ? payload.elements.filter(Boolean) : [payload.elements].filter(Boolean);
    const primary = payload.primary ?? elements[0] ?? null;
    return {
      elements,
      primary,
      devMock: Boolean(payload.devMock || primary?.devMock),
      reason: payload.reason ?? payload.devMockReason ?? primary?.reason ?? null
    };
  }
  if (payload.element) {
    return normalizeIncomingSelection(payload.element);
  }
  const element = payload.primary ?? payload;
  if (!element) return null;
  return {
    elements: [element],
    primary: element,
    devMock: Boolean(element.devMock || payload.devMock),
    reason: payload.reason ?? payload.devMockReason ?? element.reason ?? null
  };
}

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function updateSelectedLabel(metadata) {
  if (!ui.selectedLabel) return;

  let displayText = 'Waiting for a Designer selection...';

  if (typeof metadata === 'string') {
    displayText = metadata;
  } else if (metadata && typeof metadata === 'object') {
    const tag = (metadata.tagName || 'element').toLowerCase();
    const idPart = metadata.id ? `#${metadata.id}` : '';
    const selectionCount = currentSelectionState?.elements?.length ?? 0;
    const suffix = selectionCount > 1 ? ` (first of ${selectionCount} selected)` : '';
    displayText = `${tag}${idPart}${suffix}`;
  }

  ui.selectedLabel.textContent = displayText;
}

function updateSelectionDebug(selection) {
  if (!ui.selectionDebug) return;

  if (!selection) {
    ui.selectionDebug.textContent = 'No selection data received yet.';
    return;
  }

  const debugPayload = {
    tagName: selection.tagName ?? null,
    id: selection.id ?? null,
    label: selection.label ?? null,
    selector: selection.selector ?? null,
    widths: selection.widths ?? null,
    devMock: Boolean(selection.devMock),
    reason: selection.reason ?? selection.devMockReason ?? null,
    computedWidths: selection.computedWidths ?? {
      desktop: selection.computedWidthDesktop ?? null,
      mobile: selection.computedWidthMobile ?? null
    }
  };

  try {
    ui.selectionDebug.textContent = JSON.stringify(debugPayload, null, 2);
  } catch (error) {
    ui.selectionDebug.textContent = String(debugPayload);
  }
}

function setStatus(message, tone = 'info') {
  if (!ui.status) return;
  ui.status.textContent = message;

  const colors = {
    info: '#8b949e',
    error: '#f87171',
    warning: '#facc15'
  };
  ui.status.style.color = colors[tone] ?? colors.info;
}

function setAnalyzeReady(isReady) {
  analyzeSelectionReady = Boolean(isReady);
  syncAnalyzeButtonState();
}

function setAnalyzeProcessing(isProcessing) {
  analyzeProcessing = Boolean(isProcessing);
  syncAnalyzeButtonState();
}

function syncAnalyzeButtonState() {
  if (!ui.analyzeButton) return;
  const shouldDisable = analyzeProcessing || !analyzeSelectionReady;
  ui.analyzeButton.disabled = shouldDisable;
  ui.analyzeButton.textContent = analyzeProcessing ? 'Analyzing…' : 'Analyze selection';
}

function updateDevBadge() {
  if (!ui.devBadge) return;
  if (!DEV_ENVIRONMENT) {
    ui.devBadge.classList.add('hidden');
    return;
  }

  const text = 'DEV Mock Mode Active';
  ui.devBadge.textContent = text;
  ui.devBadge.classList.remove('hidden');
}

function createDevSelectionState(reason = 'dev-mode') {
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

function showDevMockSelection(reason = 'dev-mode') {
  if (!DEV_ENVIRONMENT) return;
  const payload = createDevSelectionState(reason);
  handleSelectionMessage({
    type: SELECTION_MESSAGE_TYPE,
    selection: payload,
    devMock: true
  });
}

function requestSelectionUpdate(initial = false) {
  const type = initial ? SUBSCRIBE_MESSAGE_TYPE : REQUEST_MESSAGE_TYPE;
  broadcastToHost({ type });
}

function notifyContextReady() {
  broadcastToHost({ type: CONTEXT_READY_MESSAGE_TYPE });
}

function broadcastToHost(message) {
  if (!designerMessageWindow) {
    logWarn('Unable to broadcast to designer host; target window missing.');
    return;
  }
  const targetOrigins = new Set();
  if (trustedDesignerOrigin) {
    targetOrigins.add(trustedDesignerOrigin);
  }
  if (!designerOriginConfirmed) {
    KNOWN_WEBFLOW_ORIGINS.forEach((origin) => targetOrigins.add(origin));
  }
  targetOrigins.forEach((origin) => {
    try {
      designerMessageWindow.postMessage(message, origin);
    } catch (error) {
      logWarn('Unable to communicate with Designer host.', error);
    }
  });
}

function requestHostResize(size) {
  if (!size || typeof size !== 'object') return;
  const width = Number(size.width);
  const height = Number(size.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  broadcastToHost({
    type: PANEL_RESIZE_MESSAGE_TYPE,
    size: { width, height }
  });
}

function getDesignerOriginFromReferrer() {
  if (!document?.referrer) return null;
  try {
    const refUrl = new URL(document.referrer);
    return refUrl.origin;
  } catch (error) {
    logWarn('Unable to parse Designer referrer origin.', error);
    return null;
  }
}

function isAllowedHostOrigin(origin) {
  if (!origin) return false;
  if (DEV_ENVIRONMENT) return true;
  try {
    const url = new URL(origin);
    return url.hostname === 'webflow.com' || url.hostname.endsWith(WEBFLOW_DOMAIN_SUFFIX);
  } catch (error) {
    logWarn('Invalid origin provided by Designer host.', error);
    return false;
  }
}

function isTrustedDesignerMessage(event) {
  if (!event || typeof event !== 'object') return false;
  const origin = event.origin || event.data?.origin || null;
  if (!origin || !isAllowedHostOrigin(origin)) return false;
  if (!designerOriginConfirmed) {
    trustedDesignerOrigin = origin;
    designerOriginConfirmed = true;
  }
  if (trustedDesignerOrigin !== origin) return false;
  if (designerMessageWindow && event.source && event.source !== designerMessageWindow) {
    return false;
  }
  if (!designerMessageWindow && event.source && typeof event.source.postMessage === 'function') {
    designerMessageWindow = event.source;
  }
  return true;
}
