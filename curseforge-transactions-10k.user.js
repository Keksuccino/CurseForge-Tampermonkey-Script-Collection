// ==UserScript==
// @name         CurseForge Transactions 10k per page
// @namespace    https://authors.curseforge.com/
// @version      1.0.0
// @description  Force transactions page size to 10,000
// @match        https://authors.curseforge.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const TARGET_SIZE = 10000;
  const STORAGE_KEY = 'cfTransactionsRowsPerPage';
  const DEFAULT_ROWS = 50;
  const SIZE_KEYS = [
    'limit',
    'pageSize',
    'page_size',
    'perPage',
    'per_page',
    'take',
    'first',
    'rows',
    'size',
    'count',
  ];
  const PAGE_KEYS = ['page', 'pageIndex', 'page_index', 'pageNumber', 'page_number'];
  const OFFSET_KEYS = ['offset', 'start', 'skip'];
  const RANGE_PARAM_KEYS = ['range'];
  const RANGE_HEADER_NAME = 'range';
  const RANGE_HEADER_UNIT_DEFAULT = 'transactions';
  const LIST_KEYS = ['data', 'results', 'items', 'transactions', 'list', 'rows'];
  const TOTAL_KEYS = ['total', 'totalCount', 'count', 'recordsTotal', 'totalResults'];
  const DEBUG = false;
  let uiObserver = null;
  let menuObserver = null;
  let scheduledUi = false;
  let lastMeta = null;

  function isTransactionsPage() {
    return location.hash && location.hash.startsWith('#/transactions');
  }

  function isTransactionsRequest(url) {
    return /\/_api\/transactions\b/i.test(url || '');
  }

  function getDesiredRowsPerPage() {
    const raw = localStorage.getItem(STORAGE_KEY);
    const num = Number(raw);
    if (Number.isFinite(num) && num > 0) return num;
    return DEFAULT_ROWS;
  }

  function setDesiredRowsPerPage(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return;
    localStorage.setItem(STORAGE_KEY, String(num));
  }

  function isTenKEnabled() {
    return getDesiredRowsPerPage() >= TARGET_SIZE;
  }

  function coerceSize(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return null;
    if (num < TARGET_SIZE) return TARGET_SIZE;
    return null;
  }

  function updateObject(obj) {
    let changed = false;
    if (!obj || typeof obj !== 'object') return false;

    for (const key of Object.keys(obj)) {
      const value = obj[key];

      if (SIZE_KEYS.includes(key)) {
        const next = coerceSize(value);
        if (next !== null) {
          obj[key] = next;
          changed = true;
        }
        continue;
      }

      if (value && typeof value === 'object') {
        if (updateObject(value)) changed = true;
      }
    }

    return changed;
  }

  function updateUrl(url) {
    try {
      if (!isTransactionsPage() || !isTransactionsRequest(url) || !isTenKEnabled()) return url;

      const u = new URL(url, location.origin);
      let changed = false;

      for (const key of SIZE_KEYS) {
        if (u.searchParams.has(key)) {
          const next = coerceSize(u.searchParams.get(key));
          if (next !== null) {
            u.searchParams.set(key, String(next));
            changed = true;
          }
        }
      }

      // Expand react-admin range param if present.
      if (u.searchParams.has('range')) {
        const parsed = parseRangeParam(u.searchParams.get('range'));
        if (parsed) {
          const next = formatRangeParam(0, TARGET_SIZE - 1);
          u.searchParams.set('range', next);
          changed = true;
        }
      }

      return changed ? u.toString() : url;
    } catch {
      return url;
    }
  }

  function updateBody(body, url) {
    if (!isTransactionsPage() || !isTransactionsRequest(url) || !isTenKEnabled()) return body;
    if (!body) return body;

    try {
      if (typeof body === 'string') {
        const trimmed = body.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          const parsed = JSON.parse(body);
          if (updateObject(parsed)) return JSON.stringify(parsed);
          return body;
        }

        const params = new URLSearchParams(body);
        let changed = false;
        for (const key of SIZE_KEYS) {
          if (params.has(key)) {
            const next = coerceSize(params.get(key));
            if (next !== null) {
              params.set(key, String(next));
              changed = true;
            }
          }
        }
        if (params.has('range')) {
          const parsed = parseRangeParam(params.get('range'));
          if (parsed) {
            params.set('range', formatRangeParam(0, TARGET_SIZE - 1));
            changed = true;
          }
        }
        return changed ? params.toString() : body;
      }

      if (body instanceof URLSearchParams) {
        let changed = false;
        for (const key of SIZE_KEYS) {
          if (body.has(key)) {
            const next = coerceSize(body.get(key));
            if (next !== null) {
              body.set(key, String(next));
              changed = true;
            }
          }
        }
        if (body.has('range')) {
          const parsed = parseRangeParam(body.get('range'));
          if (parsed) {
            body.set('range', formatRangeParam(0, TARGET_SIZE - 1));
            changed = true;
          }
        }
        return changed ? body : body;
      }

      if (body instanceof FormData) {
        let changed = false;
        for (const key of SIZE_KEYS) {
          if (body.has(key)) {
            const next = coerceSize(body.get(key));
            if (next !== null) {
              body.set(key, String(next));
              changed = true;
            }
          }
        }
        if (body.has('range')) {
          const parsed = parseRangeParam(body.get('range'));
          if (parsed) {
            body.set('range', formatRangeParam(0, TARGET_SIZE - 1));
            changed = true;
          }
        }
        return changed ? body : body;
      }
    } catch {
      return body;
    }

    return body;
  }

  function parseParamsFromUrl(url) {
    try {
      const u = new URL(url, location.origin);
      const params = new URLSearchParams(u.search);
      return params;
    } catch {
      return null;
    }
  }

  function parseParamsFromBody(body) {
    if (!body) return null;
    try {
      if (typeof body === 'string') {
        const trimmed = body.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          return JSON.parse(body);
        }
        return new URLSearchParams(body);
      }
      if (body instanceof URLSearchParams) return body;
      if (body instanceof FormData) return body;
    } catch {
      return null;
    }
    return null;
  }

  function parseRangeParam(value) {
    if (value == null) return null;
    if (Array.isArray(value) && value.length >= 2) {
      return { start: Number(value[0]), end: Number(value[1]) };
    }
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length >= 2) {
        return { start: Number(parsed[0]), end: Number(parsed[1]) };
      }
    } catch {
      // fall through
    }
    const dashMatch = trimmed.match(/(\d+)\s*-\s*(\d+)/);
    if (dashMatch) {
      return { start: Number(dashMatch[1]), end: Number(dashMatch[2]) };
    }
    const commaMatch = trimmed.match(/(\d+)\s*,\s*(\d+)/);
    if (commaMatch) {
      return { start: Number(commaMatch[1]), end: Number(commaMatch[2]) };
    }
    return null;
  }

  function formatRangeParam(start, end) {
    return JSON.stringify([start, end]);
  }

  function parseRangeHeader(value) {
    if (!value || typeof value !== 'string') return null;
    const parts = value.split('=');
    if (parts.length !== 2) return null;
    const unit = parts[0].trim() || RANGE_HEADER_UNIT_DEFAULT;
    const range = parseRangeParam(parts[1]);
    if (!range) return null;
    return { unit, start: range.start, end: range.end };
  }

  function formatRangeHeader(unit, start, end) {
    const finalUnit = unit || RANGE_HEADER_UNIT_DEFAULT;
    return `${finalUnit}=${start}-${end}`;
  }

  function cloneHeaders(headers) {
    if (!headers) return new Headers();
    if (headers instanceof Headers) return new Headers(headers);
    return new Headers(headers);
  }

  function updateRangeHeader(headers, start, end) {
    const next = formatRangeHeader(RANGE_HEADER_UNIT_DEFAULT, start, end);
    headers.set(RANGE_HEADER_NAME, next);
  }

  function getHeaderValue(headers, name) {
    if (!headers) return null;
    if (headers instanceof Headers) return headers.get(name);
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) return headers[key];
    }
    return null;
  }

  function updateHeadersForTransactions(headers, url) {
    if (!isTransactionsPage() || !isTransactionsRequest(url) || !isTenKEnabled()) return headers;
    const nextHeaders = cloneHeaders(headers);
    const rangeParam = (() => {
      try {
        const u = new URL(url, location.origin);
        return parseRangeParam(u.searchParams.get('range'));
      } catch {
        return null;
      }
    })();
    const headerRange = parseRangeHeader(nextHeaders.get(RANGE_HEADER_NAME));
    if (rangeParam || headerRange) {
      updateRangeHeader(nextHeaders, 0, TARGET_SIZE - 1);
      return nextHeaders;
    }
    return headers;
  }

  function parseContentRangeHeader(value) {
    if (!value || typeof value !== 'string') return null;
    const match = value.match(/^(\w+)\s+(\d+)-(\d+)\/(\d+|\*)$/);
    if (!match) return null;
    return {
      unit: match[1],
      start: Number(match[2]),
      end: Number(match[3]),
      total: match[4] === '*' ? undefined : Number(match[4]),
    };
  }

  function setParamValue(container, key, value) {
    if (!container) return;
    if (container instanceof URLSearchParams) {
      container.set(key, String(value));
      return;
    }
    if (container instanceof FormData) {
      container.set(key, String(value));
      return;
    }
    if (typeof container === 'object') {
      container[key] = value;
    }
  }

  function getParamValue(container, key) {
    if (!container) return undefined;
    if (container instanceof URLSearchParams) return container.get(key);
    if (container instanceof FormData) return container.get(key);
    if (typeof container === 'object') return container[key];
    return undefined;
  }

  function findParam(container, keys) {
    if (!container) return null;
    for (const key of keys) {
      const value = getParamValue(container, key);
      if (value !== undefined && value !== null) {
        return { key, value };
      }
    }
    return null;
  }

  function extractListAndTotal(payload) {
    if (Array.isArray(payload)) {
      return { list: payload, listKey: null, total: payload.length, totalKey: null };
    }
    if (!payload || typeof payload !== 'object') return null;

    for (const key of LIST_KEYS) {
      if (Array.isArray(payload[key])) {
        const totalEntry = findParam(payload, TOTAL_KEYS);
        return {
          list: payload[key],
          listKey: key,
          total: totalEntry ? Number(totalEntry.value) : undefined,
          totalKey: totalEntry ? totalEntry.key : null,
        };
      }
    }
    return null;
  }

  async function expandPaginatedFetch(originalRequest, response, paramsMeta) {
    try {
      if (!isTenKEnabled()) return response;
      const cloned = response.clone();
      const payload = await cloned.json();
      const parsed = extractListAndTotal(payload);
      if (!parsed || !parsed.list) return response;

      const list = parsed.list.slice();
      let total = Number.isFinite(parsed.total) ? parsed.total : undefined;
      if (total === undefined) {
        const headerTotal = parseContentRangeHeader(response.headers.get('content-range'));
        if (headerTotal && Number.isFinite(headerTotal.total)) {
          total = headerTotal.total;
        }
      }

      const initialLoaded = Math.min(list.length, TARGET_SIZE);
      lastMeta = {
        total: total,
        loaded: initialLoaded,
      };
      scheduleUiUpdate();

      if (list.length >= TARGET_SIZE) return response;
      if (total !== undefined && list.length >= total) return response;

      const pageMeta = paramsMeta.pageMeta;
      const offsetMeta = paramsMeta.offsetMeta;
      const sizeMeta = paramsMeta.sizeMeta;
      const rangeMeta = paramsMeta.rangeMeta;

      if (!pageMeta && !offsetMeta && !rangeMeta) return response;

      const perPage = list.length || (sizeMeta ? Number(sizeMeta.value) : 50);
      let nextPage = pageMeta ? Number(pageMeta.value) + 1 : null;
      let nextOffset = offsetMeta ? Number(offsetMeta.value) + perPage : null;
      let nextRangeStart = rangeMeta ? Number(rangeMeta.start) + perPage : null;

      while (list.length < TARGET_SIZE) {
        if (total !== undefined && list.length >= total) break;

        const nextRequest = paramsMeta.buildNextRequest(nextPage, nextOffset, nextRangeStart, perPage);
        if (!nextRequest) break;

        const nextRes = await fetch(nextRequest);
        if (!nextRes.ok) break;

        const nextPayload = await nextRes.json();
        const nextParsed = extractListAndTotal(nextPayload);
        if (!nextParsed || !nextParsed.list || nextParsed.list.length === 0) break;

        list.push(...nextParsed.list);
        if (nextParsed.total !== undefined && !Number.isFinite(total)) {
          // If total wasn't in the first response, take it from later pages.
          parsed.total = Number(nextParsed.total);
        }

        if (pageMeta) nextPage += 1;
        if (offsetMeta) nextOffset += perPage;
        if (rangeMeta) nextRangeStart += perPage;
      }

      const finalLoaded = Math.min(list.length, TARGET_SIZE);
      if (parsed.listKey) {
        payload[parsed.listKey] = list.slice(0, TARGET_SIZE);
      } else {
        // Response was an array.
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        if (headers.has('content-range')) {
          const parsedRange = parseContentRangeHeader(headers.get('content-range'));
          const totalValue = total !== undefined ? total : parsedRange ? parsedRange.total : undefined;
          const unit = parsedRange ? parsedRange.unit : RANGE_HEADER_UNIT_DEFAULT;
          const end = Math.min(list.length, TARGET_SIZE) - 1;
          const totalPart = totalValue !== undefined ? totalValue : '*';
          headers.set('content-range', `${unit} 0-${end}/${totalPart}`);
        }
        lastMeta = {
          total: total,
          loaded: finalLoaded,
        };
        scheduleUiUpdate();
        return new Response(JSON.stringify(list.slice(0, TARGET_SIZE)), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      if (parsed.totalKey && total !== undefined) {
        payload[parsed.totalKey] = total;
      }

      const headers = new Headers(response.headers);
      headers.delete('content-length');
      if (headers.has('content-range')) {
        const parsedRange = parseContentRangeHeader(headers.get('content-range'));
        const totalValue = total !== undefined ? total : parsedRange ? parsedRange.total : undefined;
        const unit = parsedRange ? parsedRange.unit : RANGE_HEADER_UNIT_DEFAULT;
        const end = Math.min(list.length, TARGET_SIZE) - 1;
        const totalPart = totalValue !== undefined ? totalValue : '*';
        headers.set('content-range', `${unit} 0-${end}/${totalPart}`);
      }

      lastMeta = {
        total: total,
        loaded: finalLoaded,
      };
      scheduleUiUpdate();
      return new Response(JSON.stringify(payload), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (err) {
      if (DEBUG) console.warn('[cf-10k] expand failed', err);
      return response;
    }
  }

  function buildParamsMeta(url, body, method, requestTemplate, initHeaders) {
    const urlParams = parseParamsFromUrl(url);
    const bodyParams = parseParamsFromBody(body);

    const sizeMeta = findParam(urlParams, SIZE_KEYS) || findParam(bodyParams, SIZE_KEYS);
    const pageMeta = findParam(urlParams, PAGE_KEYS) || findParam(bodyParams, PAGE_KEYS);
    const offsetMeta = findParam(urlParams, OFFSET_KEYS) || findParam(bodyParams, OFFSET_KEYS);
    const rangeParamMeta = findParam(urlParams, RANGE_PARAM_KEYS) || findParam(bodyParams, RANGE_PARAM_KEYS);

    let rangeMeta = null;
    if (rangeParamMeta) {
      const parsed = parseRangeParam(rangeParamMeta.value);
      if (parsed) {
        rangeMeta = { source: 'param', start: parsed.start, end: parsed.end, unit: RANGE_HEADER_UNIT_DEFAULT };
      }
    }

    const headerSource = requestTemplate ? requestTemplate.headers : initHeaders;
    const headerRangeValue = getHeaderValue(headerSource, RANGE_HEADER_NAME);
    const headerRangeMeta = parseRangeHeader(headerRangeValue);
    if (headerRangeMeta) {
      rangeMeta = {
        source: 'header',
        start: headerRangeMeta.start,
        end: headerRangeMeta.end,
        unit: headerRangeMeta.unit || RANGE_HEADER_UNIT_DEFAULT,
      };
    }

    const requestMethod = method || 'GET';
    const buildNextRequest = (nextPage, nextOffset, nextRangeStart, rangeSize) => {
      let nextUrl = url;
      let nextBody = body;
      let nextHeaders = null;

      if (urlParams) {
        if (sizeMeta) setParamValue(urlParams, sizeMeta.key, sizeMeta.value);
        if (pageMeta && nextPage !== null) setParamValue(urlParams, pageMeta.key, nextPage);
        if (offsetMeta && nextOffset !== null) setParamValue(urlParams, offsetMeta.key, nextOffset);
        if (rangeParamMeta && nextRangeStart !== null) {
          const size = rangeSize || (rangeMeta ? (rangeMeta.end - rangeMeta.start + 1) : TARGET_SIZE);
          const nextEnd = nextRangeStart + size - 1;
          setParamValue(urlParams, rangeParamMeta.key, formatRangeParam(nextRangeStart, nextEnd));
        }
        const u = new URL(url, location.origin);
        u.search = urlParams.toString();
        nextUrl = u.toString();
      }

      if (bodyParams && typeof bodyParams === 'object') {
        if (sizeMeta) setParamValue(bodyParams, sizeMeta.key, sizeMeta.value);
        if (pageMeta && nextPage !== null) setParamValue(bodyParams, pageMeta.key, nextPage);
        if (offsetMeta && nextOffset !== null) setParamValue(bodyParams, offsetMeta.key, nextOffset);
        if (rangeParamMeta && nextRangeStart !== null) {
          const size = rangeSize || (rangeMeta ? (rangeMeta.end - rangeMeta.start + 1) : TARGET_SIZE);
          const nextEnd = nextRangeStart + size - 1;
          setParamValue(bodyParams, rangeParamMeta.key, formatRangeParam(nextRangeStart, nextEnd));
        }
        if (bodyParams instanceof URLSearchParams) {
          nextBody = bodyParams.toString();
        } else if (bodyParams instanceof FormData) {
          nextBody = bodyParams;
        } else {
          nextBody = JSON.stringify(bodyParams);
        }
      }

      if (!nextUrl && !nextBody) return null;

      if (rangeMeta && nextRangeStart !== null) {
        const size = rangeSize || (rangeMeta.end - rangeMeta.start + 1);
        const nextEnd = nextRangeStart + size - 1;
        nextHeaders = cloneHeaders(requestTemplate ? requestTemplate.headers : initHeaders);
        updateRangeHeader(nextHeaders, nextRangeStart, nextEnd);
      }

      if (requestTemplate instanceof Request) {
        return new Request(nextUrl || requestTemplate.url, {
          method: requestTemplate.method,
          headers: nextHeaders || requestTemplate.headers,
          body: requestTemplate.method && requestTemplate.method.toUpperCase() !== 'GET' ? nextBody : undefined,
          credentials: requestTemplate.credentials,
          mode: requestTemplate.mode,
          cache: requestTemplate.cache,
          redirect: requestTemplate.redirect,
          referrer: requestTemplate.referrer,
          referrerPolicy: requestTemplate.referrerPolicy,
          integrity: requestTemplate.integrity,
          keepalive: requestTemplate.keepalive,
        });
      }

      return new Request(nextUrl || url, {
        method: requestMethod,
        body: requestMethod.toUpperCase() !== 'GET' ? nextBody : undefined,
        headers: nextHeaders || initHeaders,
        credentials: 'include',
      });
    };

    return {
      urlParams,
      bodyParams,
      sizeMeta,
      pageMeta,
      offsetMeta,
      rangeMeta,
      buildNextRequest,
    };
  }

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const method = init && init.method ? init.method : input instanceof Request ? input.method : 'GET';
    const url =
      typeof input === 'string'
        ? input
        : input && typeof input.url === 'string'
        ? input.url
        : '';

    const newUrl = updateUrl(url);
    let newInput = input;
    let updatedHeaders = updateHeadersForTransactions(
      init && init.headers ? init.headers : input instanceof Request ? input.headers : undefined,
      newUrl || url
    );

    if (newUrl && newUrl !== url) {
      if (input instanceof Request) {
        newInput = new Request(newUrl, input);
      } else {
        newInput = newUrl;
      }
    }

    if (init && init.body) {
      const newInit = Object.assign({}, init, {
        body: updateBody(init.body, newUrl || url),
        headers: updatedHeaders || init.headers,
      });
      return originalFetch(newInput, newInit).then((res) => {
        if (!isTransactionsPage() || !isTransactionsRequest(newUrl || url)) return res;
        const paramsMeta = buildParamsMeta(
          newUrl || url,
          newInit.body,
          method,
          newInput instanceof Request ? newInput : null,
          updatedHeaders || newInit.headers
        );
        return expandPaginatedFetch(newInput instanceof Request ? newInput : null, res, paramsMeta);
      });
    }

    const finalInit = init
      ? Object.assign({}, init, { headers: updatedHeaders || init.headers })
      : updatedHeaders
      ? { headers: updatedHeaders }
      : init;

    return originalFetch(newInput, finalInit).then((res) => {
      if (!isTransactionsPage() || !isTransactionsRequest(newUrl || url)) return res;
      const paramsMeta = buildParamsMeta(
        newUrl || url,
        finalInit && finalInit.body,
        method,
        newInput instanceof Request ? newInput : null,
        updatedHeaders || (finalInit && finalInit.headers)
      );
      return expandPaginatedFetch(newInput instanceof Request ? newInput : null, res, paramsMeta);
    });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__tm_url = updateUrl(url);
    this.__tm_isTransactions = isTransactionsPage() && isTransactionsRequest(this.__tm_url);
    return originalOpen.call(this, method, this.__tm_url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__tm_isTransactions && isTenKEnabled() && name && name.toLowerCase() === RANGE_HEADER_NAME) {
      const parsed = parseRangeHeader(value);
      if (parsed) {
        return originalSetRequestHeader.call(
          this,
          name,
          formatRangeHeader(parsed.unit || RANGE_HEADER_UNIT_DEFAULT, 0, TARGET_SIZE - 1)
        );
      }
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    return originalSend.call(this, updateBody(body, this.__tm_url));
  };

  function ensureTenKOption(listbox) {
    if (!isTransactionsPage()) return;
    if (!listbox || listbox.getAttribute('role') !== 'listbox') return;
    const options = Array.from(listbox.querySelectorAll('[role="option"]'));
    if (options.some((opt) => String(opt.textContent).trim() === String(TARGET_SIZE))) return;

    const template = options[0];
    if (!template) return;
    const clone = template.cloneNode(true);
    clone.textContent = String(TARGET_SIZE);
    clone.setAttribute('data-value', String(TARGET_SIZE));
    clone.setAttribute('aria-selected', isTenKEnabled() ? 'true' : 'false');
    clone.addEventListener('click', () => {
      setDesiredRowsPerPage(TARGET_SIZE);
      scheduleUiUpdate();
    });
    listbox.appendChild(clone);
  }

  function hookMenuListbox() {
    if (menuObserver) return;
    menuObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (!isTransactionsPage()) continue;
          if (!document.querySelector('.MuiTablePagination-select')) continue;
          if (node.getAttribute('role') === 'listbox') {
            ensureTenKOption(node);
            node.addEventListener('click', (event) => {
              if (!isTransactionsPage()) return;
              const target = event.target;
              if (!(target instanceof HTMLElement)) return;
              const option = target.closest('[role="option"]');
              if (!option) return;
              const text = String(option.textContent).trim();
              const num = Number(text);
              if (Number.isFinite(num) && num > 0) {
                setDesiredRowsPerPage(num);
                scheduleUiUpdate();
              }
            });
          } else {
            const listbox = node.querySelector && node.querySelector('[role="listbox"]');
            if (listbox) {
              ensureTenKOption(listbox);
            }
          }
        }
      }
    });
    menuObserver.observe(document.body, { childList: true, subtree: true });
  }

  function updateDisplayedRows() {
    if (!isTenKEnabled()) return;
    const displayed = document.querySelector('.MuiTablePagination-displayedRows');
    if (!displayed) return;
    if (!lastMeta || !Number.isFinite(lastMeta.total)) return;
    const total = lastMeta.total;
    const loaded = Number.isFinite(lastMeta.loaded) ? lastMeta.loaded : total;
    const end = Math.min(total, loaded);
    displayed.textContent = `1-${end} of ${total}`;
  }

  function updateRowsPerPageSelect() {
    const select = document.querySelector('.MuiTablePagination-select[role=\"combobox\"]');
    if (!select) return;
    const desired = getDesiredRowsPerPage();
    if (String(select.textContent).trim() !== String(desired)) {
      select.textContent = String(desired);
    }
  }

  function updatePaginationControls() {
    if (!isTenKEnabled()) return;
    const actions = document.querySelector('.MuiTablePagination-actions');
    if (!actions) return;
    const buttons = actions.querySelectorAll('button');
    buttons.forEach((btn) => {
      btn.dataset.cfTenKDisabled = '1';
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
    });
    const pageList = document.querySelector('.MuiPagination-root, .MuiPagination-ul');
    if (pageList) {
      if (!pageList.dataset.cfTenKPrevDisplay) {
        pageList.dataset.cfTenKPrevDisplay = pageList.style.display || '';
      }
      pageList.dataset.cfTenKHidden = '1';
      pageList.style.display = 'none';
    }
  }

  function resetPaginationControls() {
    const actions = document.querySelector('.MuiTablePagination-actions');
    if (!actions) return;
    const buttons = actions.querySelectorAll('button');
    buttons.forEach((btn) => {
      if (btn.dataset.cfTenKDisabled) {
        btn.disabled = false;
        btn.setAttribute('aria-disabled', 'false');
        delete btn.dataset.cfTenKDisabled;
      }
    });
    const pageList = document.querySelector('.MuiPagination-root, .MuiPagination-ul');
    if (pageList && pageList.dataset.cfTenKHidden) {
      pageList.style.display = pageList.dataset.cfTenKPrevDisplay || '';
      delete pageList.dataset.cfTenKHidden;
      delete pageList.dataset.cfTenKPrevDisplay;
    }
  }

  function applyUiState() {
    if (!isTransactionsPage()) return;
    if (isTenKEnabled()) {
      updateRowsPerPageSelect();
      updateDisplayedRows();
      updatePaginationControls();
    } else {
      resetPaginationControls();
    }
  }

  function scheduleUiUpdate() {
    if (scheduledUi) return;
    scheduledUi = true;
    setTimeout(() => {
      scheduledUi = false;
      applyUiState();
    }, 0);
  }

  function hookUiObserver() {
    if (uiObserver) return;
    uiObserver = new MutationObserver(() => {
      scheduleUiUpdate();
    });
    uiObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function initUiHooks() {
    hookMenuListbox();
    hookUiObserver();
    scheduleUiUpdate();
  }

  initUiHooks();
})();
