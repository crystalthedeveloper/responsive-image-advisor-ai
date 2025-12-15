const ANALYZE_ENDPOINT = '/analyze';
const SELECTION_MESSAGE_TYPE = 'element-selected';
const SUBSCRIBE_MESSAGE_TYPE = 'riaa:selection:subscribe';
const REQUEST_MESSAGE_TYPE = 'riaa:selection:request';
const CONTEXT_READY_MESSAGE_TYPE = 'riaa:context-ready';
const PANEL_WIDTH = 520;
const PANEL_HEIGHT = 720;
const RUNTIME_RETRY_DELAY = 300;
const RUNTIME_MAX_ATTEMPTS = 40;
const RUNTIME_TIMEOUT_MS = 15000;

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

const applyFrameSizeStyles = (node, widthPx, heightPx) => {
  if (!node) return;
  node.style.width = widthPx;
  node.style.height = heightPx;
  node.style.minWidth = widthPx;
  node.style.minHeight = heightPx;
};

const enforceFrameSize = (size) => {
  const frame = window.frameElement;
  const widthPx = `${size.width}px`;
  const heightPx = `${size.height}px`;
  applyFrameSizeStyles(frame, widthPx, heightPx);
  applyFrameSizeStyles(frame?.parentElement, widthPx, heightPx);
};

const requestPanelSize = (api, size) => {
  try {
    if (typeof api.setExtensionSize === 'function') {
      const result = api.setExtensionSize(size);
      if (result && typeof result.then === 'function') {
        result.catch(() => {});
      }
      enforceFrameSize(size);
      return true;
    }
    if (typeof api.resize === 'function') {
      api.resize(size);
      enforceFrameSize(size);
      return true;
    }
  } catch {
    enforceFrameSize(size);
  }
  return false;
};

const ensureResize = () => {
  if (typeof window === 'undefined') return;
  const size = { width: PANEL_WIDTH, height: PANEL_HEIGHT };

  getRuntimeApi()
    .then((api) => {
      if (!requestPanelSize(api, size)) {
        enforceFrameSize(size);
      }
    })
    .catch(() => enforceFrameSize(size));

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
      .catch(() => {
        if (attempts >= RUNTIME_MAX_ATTEMPTS) {
          window.clearInterval(timer);
        }
      });
  }, RUNTIME_RETRY_DELAY);
};

ensureResize();

const ui = {
  analyzeButton: document.getElementById('analyze-button'),
  refreshButton: document.getElementById('refresh-selection'),
  status: document.getElementById('status-message'),
  resultsCard: document.getElementById('results-card'),
  universalSize: document.getElementById('universal-size'),
  desktopSize: document.getElementById('desktop-size'),
  mobileSize: document.getElementById('mobile-size'),
  explanation: document.getElementById('analysis-explanation'),
  selectedLabel: document.getElementById('selected-element-text'),
  selectionDebug: document.getElementById('selection-debug')
};

let currentSelected = null;
let handshakeTimer = null;
let handshakeAttempts = 0;
let handshakeComplete = false;
const MAX_HANDSHAKE_ATTEMPTS = 30;

initPanel();

function initPanel() {
  ui.analyzeButton?.addEventListener('click', handleAnalyzeClick);
  ui.refreshButton?.addEventListener('click', () => {
    refreshSelectionLabel();
    requestSelectionUpdate(false);
  });

  window.addEventListener('message', handleSelectionMessage);
  setStatus('Waiting for a selection in the Designer...');
  requestSelectionUpdate(true);
  notifyContextReady();
  startHandshakeRetries();
}

async function handleAnalyzeClick() {
  toggleAnalyzeButton(true);
  setStatus('Checking selected element...');

  if (!currentSelected) {
    hideResults();
    setStatus('Select an image element in the Designer first.', 'warning');
    toggleAnalyzeButton(false);
    return;
  }

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
    console.error('[Responsive Image Advisor AI]', error);
    hideResults();
    setStatus(error.message || 'Unable to analyze the selected element.', 'error');
  } finally {
    toggleAnalyzeButton(false);
  }
}

function handleSelectionMessage(event) {
  if (event.data?.type !== SELECTION_MESSAGE_TYPE) return;
  currentSelected = event.data.element || null;
  handshakeComplete = true;
  stopHandshakeRetries();
  updateSelectionUI();
}

function updateSelectionUI() {
  if (!currentSelected) {
    updateSelectedLabel('Nothing selected');
    updateSelectionDebug(null);
    hideResults();
    setStatus('No element selected.', 'warning');
    return;
  }

  updateSelectedLabel(currentSelected);
  updateSelectionDebug(currentSelected);

  const measuredWidths = deriveMeasuredWidths(currentSelected);
  if (!measuredWidths) {
    setStatus('Waiting for rendered widths from Designer...', 'warning');
    return;
  }

  if (currentSelected.widths) {
    setStatus('Ready to analyze.');
  } else {
    setStatus('Ready (using measured width from Designer viewport).');
  }
}

function refreshSelectionLabel() {
  handshakeComplete = false;
  startHandshakeRetries(true);
  updateSelectionUI();
}

async function requestRecommendations(payload) {
  const response = await fetch(ANALYZE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error('The AI backend returned an error.');
  }

  return response.json();
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

  if (typeof metadata === 'string') {
    ui.selectedLabel.textContent = metadata;
    return;
  }

  if (metadata && typeof metadata === 'object') {
    const tag = (metadata.tagName || 'element').toLowerCase();
    const idPart = metadata.id ? `#${metadata.id}` : '';
    ui.selectedLabel.textContent = `${tag}${idPart}`;
    return;
  }

  ui.selectedLabel.textContent = 'Nothing selected';
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

function toggleAnalyzeButton(disabled) {
  if (!ui.analyzeButton) return;
  ui.analyzeButton.disabled = disabled;
  ui.analyzeButton.textContent = disabled ? 'Analyzing…' : 'Analyze selection';
}

function requestSelectionUpdate(initial = false) {
  const type = initial ? SUBSCRIBE_MESSAGE_TYPE : REQUEST_MESSAGE_TYPE;
  broadcastToHost({ type });
}

function notifyContextReady() {
  broadcastToHost({ type: CONTEXT_READY_MESSAGE_TYPE });
}

function broadcastToHost(message) {
  const targets = new Set();
  if (window.parent && window.parent !== window) targets.add(window.parent);
  if (window.top && window.top !== window.parent && window.top !== window) targets.add(window.top);

  targets.forEach((target) => {
    try {
      target.postMessage(message, '*');
    } catch (error) {
      console.warn('Unable to communicate with Designer host.', error);
    }
  });
}

function startHandshakeRetries(force = false) {
  if (handshakeTimer) return;
  if (handshakeComplete && !force) return;
  if (force) {
    handshakeAttempts = 0;
  }
  handshakeTimer = window.setInterval(() => {
    if (handshakeComplete || handshakeAttempts >= MAX_HANDSHAKE_ATTEMPTS) {
      stopHandshakeRetries();
      return;
    }
    handshakeAttempts += 1;
    requestSelectionUpdate(handshakeAttempts === 1);
    notifyContextReady();
  }, 1000);
}

function stopHandshakeRetries() {
  if (!handshakeTimer) return;
  window.clearInterval(handshakeTimer);
  handshakeTimer = null;
}
