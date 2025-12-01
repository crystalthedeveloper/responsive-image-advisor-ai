const ANALYZE_ENDPOINT = '/analyze';

const ui = {
  analyzeButton: document.getElementById('analyze-button'),
  refreshButton: document.getElementById('refresh-selection'),
  status: document.getElementById('status-message'),
  resultsCard: document.getElementById('results-card'),
  universalSize: document.getElementById('universal-size'),
  desktopSize: document.getElementById('desktop-size'),
  mobileSize: document.getElementById('mobile-size'),
  explanation: document.getElementById('analysis-explanation'),
  selectedLabel: document.getElementById('selected-element-text')
};

let selectedElementMetadata = null;
let awaitingSelectionResponse = false;

// -------------------------------
// INIT PANEL
// -------------------------------
initPanel();

function initPanel() {
  ui.analyzeButton?.addEventListener('click', handleAnalyzeClick);
  ui.refreshButton?.addEventListener('click', refreshSelectionLabel);

  // Listen for messages from Webflow Designer
  window.addEventListener('message', handleDesignerMessage);

  // Request initial selection on load
  refreshSelectionLabel();
}

// -------------------------------
// ANALYZE CLICK
// -------------------------------
async function handleAnalyzeClick() {
  toggleAnalyzeButton(true);
  setStatus('Requesting selection from Designer...');

  try {
    const selection = await ensureSelectionMetadata();

    if (!selection?.widths?.desktop) {
      throw new Error('Designer did not provide rendered widths for the selected element.');
    }

    setStatus('Sending widths to AI backend...');
    const recommendations = await requestRecommendations({
      element: {
        label: selection.label ?? 'Selected element',
        tagName: selection.tagName ?? null,
        selector: selection.selector ?? null
      },
      widths: selection.widths
    });

    renderResults(recommendations, selection.widths);
    setStatus('Analysis complete.');
  } catch (error) {
    console.error('[Responsive Image Advisor AI]', error);
    hideResults();
    setStatus(error.message || 'Unable to analyze the selected element.', 'error');
  } finally {
    toggleAnalyzeButton(false);
  }
}

// -------------------------------
// ENSURE WE HAVE SELECTION
// -------------------------------
function ensureSelectionMetadata(timeoutMs = 3000) {
  if (selectedElementMetadata) return Promise.resolve(selectedElementMetadata);

  requestSelectedElement();
  const start = performance.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      if (selectedElementMetadata) {
        resolve(selectedElementMetadata);
        return;
      }
      if (performance.now() - start > timeoutMs) {
        reject(new Error('No element selected in the Designer.'));
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  });
}

// -------------------------------
// REQUEST SELECTION FROM DESIGNER
// -------------------------------
function refreshSelectionLabel() {
  requestSelectedElement();
}

function requestSelectedElement() {
  if (awaitingSelectionResponse) return;

  awaitingSelectionResponse = true;

  try {
    window.parent.postMessage({ type: 'webflow:request:selection' }, '*');
  } catch (error) {
    console.warn('Unable to message Designer frame.', error);
  }

  setTimeout(() => {
    awaitingSelectionResponse = false;
  }, 800);
}

// -------------------------------
// HANDLE RESPONSE FROM DESIGNER
// -------------------------------
function handleDesignerMessage(event) {
  const data = event.data;
  if (!data) return;

  if (data.type === 'webflow:response:selection') {
    awaitingSelectionResponse = false;

    selectedElementMetadata = data.payload || null;

    if (!selectedElementMetadata) {
      updateSelectedLabel('Nothing selected');
      hideResults();
      setStatus('No element selected.', 'warning');
      return;
    }

    updateSelectedLabel(selectedElementMetadata);

    if (!selectedElementMetadata.widths) {
      setStatus('Waiting for rendered widths from Designer...', 'warning');
    } else {
      setStatus('Ready to analyze.');
    }
  }
}

// -------------------------------
// AI BACKEND CALL
// -------------------------------
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

// -------------------------------
// RESULTS UI
// -------------------------------
function renderResults(recommendations, measuredWidths) {
  const universal = recommendations?.universalUploadSize ?? measuredWidths.desktop * 2;
  const desktop = recommendations?.desktopRenderSize ?? measuredWidths.desktop;
  const mobile = recommendations?.mobileRenderSize ?? measuredWidths.mobile;
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

// -------------------------------
// SELECTION LABEL
// -------------------------------
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

// -------------------------------
// UI HELPERS
// -------------------------------
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