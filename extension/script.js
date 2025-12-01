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
  selectedLabel: document.getElementById('selected-element-label')
};

const hostWindow = getHostWindow();
const designerContext = { designer: null, breakpoints: null, ready: false };
let selectionSubscriptionAttempted = false;

initPanel();

function initPanel() {
  ui.analyzeButton?.addEventListener('click', handleAnalyzeClick);
  ui.refreshButton?.addEventListener('click', refreshSelectionLabel);
  refreshSelectionLabel();
}

async function handleAnalyzeClick() {
  toggleAnalyzeButton(true);
  setStatus('Gathering selection from Designer...');

  try {
    const { designer, breakpoints } = await ensureDesignerContext();
    const designerSelection = getSelectedDesignerElement(designer);
    if (!designerSelection) {
      throw new Error('Select an element on the canvas first.');
    }

    const domNode = resolveDomNode(designerSelection, hostWindow);
    if (!domNode) {
      throw new Error('Unable to resolve the selected element in the canvas.');
    }

    const humanLabel = describeDomNode(domNode, designerSelection);
    updateSelectedLabel(humanLabel);

    setStatus('Measuring rendered widths across breakpoints...');
    const renderedWidths = await measureBreakpointWidths(domNode, breakpoints);

    setStatus('Sending widths to AI backend...');
    const recommendations = await requestRecommendations({
      element: {
        label: humanLabel,
        tagName: domNode.tagName?.toLowerCase() ?? null,
        selector: getUniqueSelector(domNode)
      },
      widths: renderedWidths
    });

    renderResults(recommendations, renderedWidths);
    setStatus('Analysis complete.');
  } catch (error) {
    console.error('[Responsive Image Advisor AI]', error);
    hideResults();
    setStatus(error.message || 'Unable to analyze the selected element.', 'error');
  } finally {
    toggleAnalyzeButton(false);
  }
}

async function ensureDesignerContext(timeoutMs = 10000) {
  if (designerContext.ready && designerContext.designer) {
    return designerContext;
  }

  const start = performance.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const resolved = tryResolveDesignerModules();
      if (resolved) {
        designerContext.designer = resolved.designer;
        designerContext.breakpoints = resolved.breakpoints;
        designerContext.ready = true;
        maybeSubscribeToSelection(designerContext.designer);
        resolve(designerContext);
        return;
      }

      if (performance.now() - start > timeoutMs) {
        reject(new Error('Unable to reach Webflow Designer APIs. Make sure the Designer is open.'));
        return;
      }

      requestAnimationFrame(check);
    };

    check();
  });
}

function tryResolveDesignerModules() {
  const requireFn = hostWindow?.Webflow?.require;
  if (typeof requireFn !== 'function') {
    return null;
  }

  let designerModule = null;
  let breakpointModule = null;

  const designerCandidates = ['app-designer', 'designer', 'core/designer'];
  for (const name of designerCandidates) {
    try {
      designerModule = requireFn(name);
      if (designerModule) break;
    } catch (error) {
      // Ignore modules that are not available yet.
    }
  }

  const breakpointCandidates = ['app-breakpoints', 'breakpoints', 'core/breakpoints'];
  for (const name of breakpointCandidates) {
    try {
      breakpointModule = requireFn(name);
      if (breakpointModule) break;
    } catch (error) {
      // Ignore modules that are not available yet.
    }
  }

  if (!designerModule) {
    return null;
  }

  return { designer: designerModule, breakpoints: breakpointModule };
}

function maybeSubscribeToSelection(designer) {
  if (selectionSubscriptionAttempted || !designer) {
    return;
  }

  selectionSubscriptionAttempted = true;
  const handler = () => refreshSelectionLabel();
  const eventNames = ['selection:changed', 'selection-changed', 'selectionchange', 'selection-change'];

  for (const eventName of eventNames) {
    try {
      designer.on?.(eventName, handler);
    } catch (error) {
      // Ignore subscription failures on specific channels.
    }

    try {
      designer.subscribe?.(eventName, handler);
    } catch (error) {
      // Ignore subscription failures on specific channels.
    }
  }
}

async function refreshSelectionLabel() {
  try {
    const { designer } = await ensureDesignerContext();
    const selection = getSelectedDesignerElement(designer);
    if (!selection) {
      updateSelectedLabel('Nothing selected');
      return;
    }

    const domNode = resolveDomNode(selection, hostWindow);
    if (!domNode) {
      updateSelectedLabel('Element detected but not accessible');
      return;
    }

    updateSelectedLabel(describeDomNode(domNode, selection));
  } catch (error) {
    updateSelectedLabel('Waiting for Designer...');
  }
}

function getSelectedDesignerElement(designer) {
  if (!designer) {
    return null;
  }

  const selectors = [
    () => designer.getSelectedElement?.(),
    () => designer.getSelectedNode?.(),
    () => designer.selection?.get?.(),
    () => designer.selection?.(),
    () => designer.getCurrentSelection?.(),
    () => designer.state?.selection,
    () => designer.currentSelection
  ];

  for (const getter of selectors) {
    try {
      const result = getter?.();
      if (!result) {
        continue;
      }

      if (Array.isArray(result)) {
        if (result.length === 0) {
          continue;
        }
        return result[0];
      }

      return result;
    } catch (error) {
      // Move to the next strategy.
    }
  }

  return null;
}

function resolveDomNode(selection, windowContext) {
  if (!selection) {
    return null;
  }

  const candidateOrder = [
    selection,
    selection.el,
    selection._el,
    selection.$el?.[0],
    selection.$el?.get?.(0),
    selection.dom,
    selection.node,
    selection.element,
    selection.nativeElement,
    typeof selection.get === 'function' ? selection.get(0) : null
  ];

  for (const candidate of candidateOrder) {
    if (candidate instanceof Element) {
      return candidate;
    }
  }

  try {
    if (windowContext && selection instanceof windowContext.HTMLElement) {
      return selection;
    }
  } catch (error) {
    // Ignore type guards that might throw in older browsers.
  }

  return null;
}

function describeDomNode(domNode, selection) {
  if (!domNode) {
    return 'Unknown element';
  }

  if (selection?.label) {
    return selection.label;
  }

  if (selection?.name) {
    return selection.name;
  }

  const idPart = domNode.id ? `#${domNode.id}` : '';
  const classPart = domNode.classList.length ? `.${[...domNode.classList].join('.')}` : '';
  return `${domNode.tagName?.toLowerCase() ?? 'element'}${idPart}${classPart}`;
}

async function measureBreakpointWidths(domNode, breakpointApi) {
  const blueprint = getBreakpointBlueprint(breakpointApi);
  const widths = {};
  const initialId = getActiveBreakpointId(breakpointApi);

  for (const bp of blueprint) {
    const switched = await activateBreakpoint(breakpointApi, bp.id);
    if (switched) {
      await waitForHostFrame();
    }

    widths[bp.key] = Math.round(domNode.getBoundingClientRect().width);
  }

  if (initialId && initialId !== getActiveBreakpointId(breakpointApi)) {
    await activateBreakpoint(breakpointApi, initialId);
  }

  if (!widths.desktop) {
    widths.desktop = widths.tablet ?? widths.mobile ?? Math.round(domNode.getBoundingClientRect().width);
  }

  if (!widths.mobile) {
    widths.mobile = widths.tablet ?? widths.desktop;
  }

  return widths;
}

function getBreakpointBlueprint(breakpointApi) {
  const fallback = [
    { id: 'desktop', key: 'desktop' },
    { id: 'tablet', key: 'tablet' },
    { id: 'mobile', key: 'mobile' }
  ];

  if (!breakpointApi) {
    return fallback;
  }

  const available = resolveBreakpointList(breakpointApi);
  if (available.length === 0) {
    return fallback;
  }

  const desktop = available.find((bp) => matchesBreakpoint(bp, ['desktop', 'base', 'large'])) ?? available[0];
  const tablet = available.find((bp) => matchesBreakpoint(bp, ['tablet', 'medium']));
  const mobile =
    available.find((bp) => matchesBreakpoint(bp, ['mobile portrait', 'mobile-portrait', 'mobile', 'phone'])) ??
    available.find((bp) => matchesBreakpoint(bp, ['mobile landscape', 'mobile-landscape', 'small'])) ??
    available.at(-1);

  const blueprint = [];
  if (desktop) {
    blueprint.push({ id: desktop.id ?? desktop.key ?? desktop.slug ?? 'desktop', key: 'desktop' });
  }

  if (tablet) {
    blueprint.push({ id: tablet.id ?? tablet.key ?? tablet.slug ?? 'tablet', key: 'tablet' });
  }

  if (mobile) {
    blueprint.push({ id: mobile.id ?? mobile.key ?? mobile.slug ?? 'mobile', key: 'mobile' });
  }

  return blueprint.length ? blueprint : fallback;
}

function resolveBreakpointList(breakpointApi) {
  const sources = [
    breakpointApi.getBreakpoints?.(),
    breakpointApi.list?.(),
    breakpointApi.breakpoints,
    breakpointApi.items,
    breakpointApi
  ];

  for (const source of sources) {
    if (!source) {
      continue;
    }

    if (Array.isArray(source)) {
      return source;
    }

    if (Array.isArray(source?.items)) {
      return source.items;
    }
  }

  return [];
}

function matchesBreakpoint(breakpoint, labels) {
  const lowerName = (breakpoint?.label || breakpoint?.name || breakpoint?.id || '').toLowerCase();
  return labels.some((label) => lowerName.includes(label));
}

function getActiveBreakpointId(breakpointApi) {
  if (!breakpointApi) {
    return null;
  }

  const strategies = [
    () => breakpointApi.getActiveBreakpoint?.(),
    () => breakpointApi.getCurrentBreakpoint?.(),
    () => breakpointApi.getSelectedBreakpoint?.(),
    () => breakpointApi.activeBreakpoint,
    () => breakpointApi.active,
    () => breakpointApi.state?.active,
    () => breakpointApi.current
  ];

  for (const strategy of strategies) {
    try {
      const value = strategy?.();
      if (!value) {
        continue;
      }

      if (typeof value === 'string') {
        return value;
      }

      if (value?.id) {
        return value.id;
      }
    } catch (error) {
      // Ignore strategy failures.
    }
  }

  return null;
}

async function activateBreakpoint(breakpointApi, breakpointId) {
  if (!breakpointApi || !breakpointId) {
    return false;
  }

  const setters = [
    () => breakpointApi.setActiveBreakpoint?.(breakpointId),
    () => breakpointApi.setCurrentBreakpoint?.(breakpointId),
    () => breakpointApi.setSelectedBreakpoint?.(breakpointId),
    () => breakpointApi.activateBreakpoint?.(breakpointId),
    () => breakpointApi.activate?.(breakpointId),
    () => breakpointApi.set?.('activeBreakpoint', breakpointId)
  ];

  for (const setter of setters) {
    try {
      const result = setter?.();
      if (result === undefined) {
        continue;
      }

      if (typeof result?.then === 'function') {
        await result;
      }

      return true;
    } catch (error) {
      // Try the next setter.
    }
  }

  return false;
}

function waitForHostFrame() {
  return new Promise((resolve) => {
    const targetWindow = hostWindow || window;
    targetWindow.requestAnimationFrame(() => targetWindow.requestAnimationFrame(resolve));
  });
}

async function requestRecommendations(payload) {
  const response = await fetch(ANALYZE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error('The AI backend returned an error.');
  }

  return response.json();
}

function renderResults(recommendations, measuredWidths) {
  const universal = recommendations?.universalUploadSize ?? measuredWidths.desktop * 2;
  const desktop = recommendations?.desktopRenderSize ?? measuredWidths.desktop;
  const mobile = recommendations?.mobileRenderSize ?? measuredWidths.mobile;
  const explanation =
    recommendations?.explanation ||
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
  if (!Number.isFinite(value)) {
    return '--';
  }

  return `${Math.round(value)}px`;
}

function updateSelectedLabel(message) {
  if (ui.selectedLabel) {
    ui.selectedLabel.textContent = message;
  }
}

function setStatus(message, tone = 'info') {
  if (!ui.status) {
    return;
  }

  ui.status.textContent = message;
  const palette = {
    info: '#8b949e',
    error: '#f87171',
    warning: '#facc15'
  };
  ui.status.style.color = palette[tone] ?? palette.info;
}

function toggleAnalyzeButton(disabled) {
  if (!ui.analyzeButton) {
    return;
  }

  ui.analyzeButton.disabled = disabled;
  ui.analyzeButton.textContent = disabled ? 'Analyzing…' : 'Analyze selection';
}

function getUniqueSelector(element) {
  if (!element || !(element instanceof Element)) {
    return null;
  }

  const parts = [];
  let current = element;

  while (current && current.nodeType === 1 && parts.length < 4) {
    let selector = current.nodeName.toLowerCase();

    if (current.id) {
      selector += `#${current.id}`;
      parts.unshift(selector);
      break;
    }

    if (current.classList.length) {
      selector += `.${[...current.classList].slice(0, 3).join('.')}`;
    }

    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((child) => child.nodeName === current.nodeName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    parts.unshift(selector);
    current = parent;
  }

  return parts.join(' > ');
}

function getHostWindow() {
  try {
    if (window.parent && window.parent !== window) {
      return window.parent;
    }
  } catch (error) {
    // Cross-origin access denied; fall back to current window.
  }

  return window;
}
