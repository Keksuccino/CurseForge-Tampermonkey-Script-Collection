// ==UserScript==
// @name         CurseForge Transactions Export CSV
// @namespace    https://authors.curseforge.com/
// @version      1.0.0
// @description  Add an Export to CSV button on the transactions page
// @match        https://authors.curseforge.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const API_RE = /\/\_api\/transactions\b/i;
  const EXPORT_PAGE_SIZE = 10000;
  const MAX_PAGES = 500;
  const LIST_KEYS = ['data', 'results', 'items', 'transactions', 'list', 'rows'];
  const TOTAL_KEYS = ['total', 'totalCount', 'count', 'recordsTotal', 'totalResults'];

  let lastRequest = null;
  let lastPayload = null;
  let exportButton = null;
  let exportLabel = null;
  let uiObserver = null;
  let scheduledUi = false;
  let exporting = false;

  function isTransactionsPage() {
    return location.hash && location.hash.startsWith('#/transactions');
  }

  function isTransactionsUrl(url) {
    return API_RE.test(url || '');
  }

  function resolveUrl(url) {
    try {
      return new URL(url, location.origin).toString();
    } catch {
      return url;
    }
  }

  function headersToObject(headers) {
    const out = {};
    if (!headers) return out;
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        out[key.toLowerCase()] = value;
      });
      return out;
    }
    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (!pair) continue;
        const key = String(pair[0] || '').toLowerCase();
        out[key] = pair[1];
      }
      return out;
    }
    for (const [key, value] of Object.entries(headers)) {
      out[String(key).toLowerCase()] = value;
    }
    return out;
  }

  function bodyToText(body) {
    if (!body) return null;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      const params = new URLSearchParams();
      for (const [key, value] of body.entries()) {
        params.append(key, String(value));
      }
      return params.toString();
    }
    try {
      return JSON.stringify(body);
    } catch {
      return null;
    }
  }

  function recordRequest(info) {
    if (!info || !info.url || !isTransactionsUrl(info.url)) return;
    lastRequest = {
      url: info.url,
      method: info.method || 'GET',
      headers: info.headers || {},
      body: info.body || null,
    };
  }

  function parseRangeParam(raw) {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length >= 2) {
        return { start: Number(parsed[0]), end: Number(parsed[1]) };
      }
    } catch {
      // ignore
    }
    return null;
  }

  function formatRangeParam(start, end) {
    return `[${start},${end}]`;
  }

  function parseContentRange(value) {
    if (!value || typeof value !== 'string') return null;
    const match = value.match(/(\d+)-(\d+)\/(\d+|\*)/);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === '*' ? null : Number(match[3]);
    return { start, end, total };
  }

  function extractList(payload) {
    if (!payload) return null;
    if (Array.isArray(payload)) return payload;
    if (typeof payload !== 'object') return null;
    for (const key of LIST_KEYS) {
      if (Array.isArray(payload[key])) return payload[key];
    }
    return null;
  }

  function extractTotal(payload) {
    if (!payload || typeof payload !== 'object') return null;
    for (const key of TOTAL_KEYS) {
      const value = payload[key];
      if (Number.isFinite(Number(value))) return Number(value);
    }
    return null;
  }

  function capturePayload(payload, headers) {
    const items = extractList(payload);
    if (!items) return;

    let total = extractTotal(payload);
    if (total == null && headers) {
      const contentRange = headers.get ? headers.get('content-range') : headers['content-range'];
      const parsed = parseContentRange(contentRange);
      if (parsed && parsed.total != null) total = parsed.total;
    }

    lastPayload = {
      items,
      total: total != null ? total : items.length,
      capturedAt: Date.now(),
    };
  }

  function interceptFetch() {
    const originalFetch = window.fetch;
    if (!originalFetch) return;

    window.fetch = function (input, init) {
      const request = input instanceof Request ? input : null;
      const url = typeof input === 'string' ? input : request ? request.url : String(input);
      const method = (init && init.method) || (request && request.method) || 'GET';
      const headers = headersToObject((init && init.headers) || (request && request.headers));
      const body = init && init.body ? bodyToText(init.body) : null;

      if (isTransactionsUrl(url)) {
        recordRequest({ url: resolveUrl(url), method, headers, body });
      }

      const responsePromise = originalFetch.apply(this, arguments);
      return responsePromise.then((response) => {
        if (isTransactionsUrl(url)) {
          try {
            response.clone().json().then((payload) => {
              capturePayload(payload, response.headers);
            }).catch(() => {});
          } catch {
            // ignore
          }
        }
        return response;
      });
    };
  }

  function interceptXhr() {
    const proto = XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    const originalSetHeader = proto.setRequestHeader;

    proto.open = function (method, url) {
      this._cfTxUrl = resolveUrl(url);
      this._cfTxMethod = method || 'GET';
      this._cfTxHeaders = {};
      return originalOpen.apply(this, arguments);
    };

    proto.setRequestHeader = function (name, value) {
      if (this._cfTxHeaders) this._cfTxHeaders[String(name).toLowerCase()] = value;
      return originalSetHeader.apply(this, arguments);
    };

    proto.send = function (body) {
      if (this._cfTxUrl && isTransactionsUrl(this._cfTxUrl)) {
        recordRequest({
          url: this._cfTxUrl,
          method: this._cfTxMethod,
          headers: this._cfTxHeaders || {},
          body: bodyToText(body),
        });

        this.addEventListener('load', () => {
          try {
            const text = this.responseText;
            if (!text) return;
            const payload = JSON.parse(text);
            capturePayload(payload, {
              get: (name) => this.getResponseHeader(name),
            });
          } catch {
            // ignore
          }
        });
      }

      return originalSend.apply(this, arguments);
    };
  }

  function updateBodyRange(bodyText, start, end) {
    if (!bodyText || typeof bodyText !== 'string') return bodyText;
    const trimmed = bodyText.trim();

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(bodyText);
        if (parsed && typeof parsed === 'object') {
          if (parsed.range) parsed.range = [start, end];
          return JSON.stringify(parsed);
        }
      } catch {
        return bodyText;
      }
    }

    const params = new URLSearchParams(bodyText);
    if (params.has('range')) {
      params.set('range', formatRangeParam(start, end));
      return params.toString();
    }

    return bodyText;
  }

  function buildRequestForRange(start, end) {
    if (!lastRequest) return null;

    const url = new URL(lastRequest.url, location.origin);
    url.searchParams.set('range', formatRangeParam(start, end));

    const headers = new Headers();
    for (const [key, value] of Object.entries(lastRequest.headers || {})) {
      if (value != null) headers.set(key, value);
    }
    headers.set('range', `transactions=${start}-${end}`);

    const method = (lastRequest.method || 'GET').toUpperCase();
    const options = {
      method,
      headers,
      credentials: 'include',
    };

    if (method !== 'GET' && method !== 'HEAD' && lastRequest.body) {
      options.body = updateBodyRange(lastRequest.body, start, end);
    }

    return { url: url.toString(), options };
  }

  async function fetchTransactionsPage(start, end) {
    const request = buildRequestForRange(start, end);
    if (!request) throw new Error('No transaction request captured yet.');

    const response = await fetch(request.url, request.options);
    const payload = await response.json();
    const items = extractList(payload) || [];
    let total = extractTotal(payload);

    if (total == null) {
      const contentRange = response.headers.get('content-range');
      const parsed = parseContentRange(contentRange);
      if (parsed && parsed.total != null) total = parsed.total;
    }

    if (total == null) total = items.length;
    return { items, total };
  }

  async function fetchAllTransactions() {
    const pages = [];
    let total = null;
    let start = 0;

    for (let i = 0; i < MAX_PAGES; i += 1) {
      const end = start + EXPORT_PAGE_SIZE - 1;
      const result = await fetchTransactionsPage(start, end);
      if (total == null && Number.isFinite(result.total)) total = result.total;

      if (!result.items.length) break;
      pages.push(...result.items);

      if (total != null && pages.length >= total) break;
      start += result.items.length;
    }

    if (total != null && pages.length > total) {
      pages.length = total;
    }

    return { items: pages, total };
  }

  function csvEscape(value) {
    if (value == null) return '';
    let text = '';
    if (typeof value === 'string') {
      text = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      text = String(value);
    } else {
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
    }

    if (/^[\s\S]*[",\n\r][\s\S]*$/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function buildCsv(items) {
    if (!items || !items.length) return '';

    const columns = [];
    const seen = new Set();
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      for (const key of Object.keys(item)) {
        if (!seen.has(key)) {
          seen.add(key);
          columns.push(key);
        }
      }
    }

    const lines = [];
    lines.push(columns.map(csvEscape).join(','));

    for (const item of items) {
      const row = columns.map((key) => csvEscape(item ? item[key] : ''));
      lines.push(row.join(','));
    }

    return lines.join('\r\n');
  }

  function downloadCsv(csv, filename) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function setButtonState(text, disabled) {
    if (!exportButton) return;
    if (exportLabel) {
      exportLabel.textContent = text;
    } else {
      exportButton.textContent = text;
    }
    exportButton.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    exportButton.style.pointerEvents = disabled ? 'none' : '';
    exportButton.style.opacity = disabled ? '0.6' : '';
  }

  function formatDateForFilename(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
  }

  async function handleExportClick() {
    if (exporting) return;

    if (!lastRequest) {
      alert('No transactions request captured yet. Open the Transactions page and wait for the table to load, then try again.');
      return;
    }

    exporting = true;
    setButtonState('Exporting...', true);

    try {
      let data = null;
      if (lastPayload && lastPayload.items && lastPayload.total != null && lastPayload.items.length >= lastPayload.total) {
        data = { items: lastPayload.items, total: lastPayload.total };
      } else {
        data = await fetchAllTransactions();
      }

      if (!data.items.length) {
        alert('No transactions found for the current filter.');
        return;
      }

      const csv = buildCsv(data.items);
      const filename = `curseforge-transactions-${formatDateForFilename(new Date())}.csv`;
      downloadCsv(csv, filename);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      alert(`Export failed: ${message}`);
    } finally {
      exporting = false;
      setButtonState('Export to CSV', false);
    }
  }

  function findTypeFilterAnchor() {
    const allComboboxes = Array.from(document.querySelectorAll('div[role="combobox"]'));
    const candidates = allComboboxes.filter((el) => !el.closest('.MuiTablePagination-root'));

    for (const el of candidates) {
      const labelId = el.getAttribute('aria-labelledby');
      if (labelId) {
        const labelEl = document.getElementById(labelId.split(' ')[0]);
        const labelText = labelEl ? labelEl.textContent || '' : '';
        if (/type|transaction/i.test(labelText)) return el;
      }
    }

    const preferred = candidates.find((el) => el.closest('.RaFilterForm') || el.closest('[class*="FilterForm"]') || el.closest('form'));
    return preferred || candidates[0] || null;
  }

  function createDownloadIcon(sourceIcon) {
    const svgNs = 'http://www.w3.org/2000/svg';
    let icon = null;

    if (sourceIcon) {
      icon = sourceIcon.cloneNode(true);
      while (icon.firstChild) icon.removeChild(icon.firstChild);
    } else {
      icon = document.createElementNS(svgNs, 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('class', 'MuiSelect-icon');
    }

    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');

    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M5 20h14v-2H5v2zm5-17h4v8h3l-5 5-5-5h3V3z');
    icon.appendChild(path);

    return icon;
  }

  function buildSelectStyledButton(anchor) {
    const inputRoot = anchor.closest('.MuiInputBase-root') || anchor.parentElement;
    const root = inputRoot ? inputRoot.cloneNode(false) : document.createElement('div');
    if (!inputRoot) root.className = anchor.className || '';

    root.removeAttribute('id');
    root.removeAttribute('role');
    root.removeAttribute('aria-labelledby');
    root.removeAttribute('aria-controls');
    root.removeAttribute('aria-owns');
    root.removeAttribute('aria-haspopup');
    root.removeAttribute('aria-expanded');
    root.style.marginLeft = '8px';

    const button = document.createElement('div');
    button.className = anchor.className || '';
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.setAttribute('aria-label', 'Export to CSV');
    button.style.cursor = 'pointer';
    button.style.userSelect = 'none';

    const label = document.createElement('span');
    label.textContent = 'Export to CSV';
    label.setAttribute('data-cf-export-label', '1');
    button.appendChild(label);

    button.addEventListener('click', handleExportClick);
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleExportClick();
      }
    });

    root.appendChild(button);

    const sourceIcon = inputRoot ? inputRoot.querySelector('svg') : null;
    root.appendChild(createDownloadIcon(sourceIcon));

    return { root, button, label };
  }

  function ensureExportButton() {
    if (!isTransactionsPage()) return;
    if (exportButton && document.body.contains(exportButton)) return;

    const anchor = findTypeFilterAnchor();
    if (!anchor) return;

    const control = anchor.closest('.MuiFormControl-root') || anchor.parentElement;
    if (!control || !control.parentElement) return;

    const built = buildSelectStyledButton(anchor);
    control.parentElement.insertBefore(built.root, control.nextSibling);
    exportButton = built.button;
    exportLabel = built.label;
  }

  function scheduleUiUpdate() {
    if (scheduledUi) return;
    scheduledUi = true;
    requestAnimationFrame(() => {
      scheduledUi = false;
      ensureExportButton();
    });
  }

  function observeUi() {
    if (uiObserver) return;
    uiObserver = new MutationObserver(() => scheduleUiUpdate());
    uiObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
    scheduleUiUpdate();
  }

  function init() {
    interceptFetch();
    interceptXhr();

    window.addEventListener('hashchange', () => {
      scheduleUiUpdate();
    });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => observeUi());
    } else {
      observeUi();
    }
  }

  init();
})();
