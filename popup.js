'use strict';

const STORAGE_PRODUCT_KEY = 'currentProduct';
const STORAGE_STATUS_KEY = 'currentProductStatus';
const STORAGE_DEBUG_KEY = 'debugLogs';
const RESULT_CACHE_PREFIX = 'spf_result_';
const RESULT_CACHE_INDEX_KEY = 'spf_result_index';
const RESULT_CACHE_MAX_ITEMS = 50;
const RESULT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const ITEM_URL_PATTERNS = [
  /(?:^|[/-])i\.(\d+)\.(\d+)(?=$|[/?#&])/,
  /\/product\/(\d+)\/(\d+)(?=$|[/?#&])/
];

const state = {
  activeTab: null,
  currentProduct: null,
  isLoading: false,
  debugVisible: false,
  lastPayload: null,
  lastResults: [],
  resultFilter: '',
  excludeFilter: '',
  minSoldFilter: 0,
  minScoreFilter: 0,
  onlyHcmFilter: false,
  sortKey: 'score',
  sortDirection: 'desc',
  cacheUpdatedAt: 0,
  autoLoadTimer: null
};

const elements = {};

function $(selector) {
  return document.querySelector(selector);
}

function initElements() {
  elements.pageStatus = $('#pageStatus');
  elements.emptyState = $('#emptyState');
  elements.currentProduct = $('#currentProduct');
  elements.currentImage = $('#currentImage');
  elements.currentName = $('#currentName');
  elements.currentProductId = $('#currentProductId');
  elements.currentPrice = $('#currentPrice');
  elements.currentRating = $('#currentRating');
  elements.currentSold = $('#currentSold');
  elements.findButton = $('#findButton');
  elements.searchModeSelect = $('#searchModeSelect');
  elements.returnLimitSelect = $('#returnLimitSelect');
  elements.cacheMeta = $('#cacheMeta');
  elements.clearCachedResultsButton = $('#clearCachedResultsButton');
  elements.loadingState = $('#loadingState');
  elements.errorBox = $('#errorBox');
  elements.results = $('#results');
  elements.resultSummary = $('#resultSummary');
  elements.resultFilterBox = $('#resultFilterBox');
  elements.resultFilterInput = $('#resultFilterInput');
  elements.excludeFilterInput = $('#excludeFilterInput');
  elements.clearFilterButton = $('#clearFilterButton');
  elements.minSoldInput = $('#minSoldInput');
  elements.minScoreInput = $('#minScoreInput');
  elements.onlyHcmCheckbox = $('#onlyHcmCheckbox');
  elements.scoreGuide = $('#scoreGuide');
  elements.techInfoPanel = $('#techInfoPanel');
  elements.techInfoContent = $('#techInfoContent');
  elements.filterCount = $('#filterCount');
  elements.toggleDebugButton = $('#toggleDebugButton');
  elements.copyDebugButton = $('#copyDebugButton');
  elements.clearDebugButton = $('#clearDebugButton');
  elements.debugPanel = $('#debugPanel');
  elements.debugOutput = $('#debugOutput');
  elements.debugCount = $('#debugCount');
}

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return String(value);
  }
}

function appendDebugLog(scope, message, data = {}) {
  const entry = {
    time: nowIso(),
    scope,
    message,
    data: safeJson(data)
  };

  console.log(`[SPF:${scope}] ${message}`, data);

  chrome.storage.local.get([STORAGE_DEBUG_KEY], (result) => {
    const currentLogs = Array.isArray(result && result[STORAGE_DEBUG_KEY]) ? result[STORAGE_DEBUG_KEY] : [];
    const nextLogs = currentLogs.concat(entry).slice(-220);
    chrome.storage.local.set({ [STORAGE_DEBUG_KEY]: nextLogs }, () => {
      if (state.debugVisible) {
        renderDebugLogs();
      }
    });
  });
}

function parseShopeeProductIds(url = '') {
  const textUrl = String(url || '');

  for (const pattern of ITEM_URL_PATTERNS) {
    const match = textUrl.match(pattern);
    if (match) {
      return {
        shopId: Number(match[1]),
        itemId: Number(match[2]),
        productKey: `${match[1]}_${match[2]}`
      };
    }
  }

  return null;
}

function isShopeeUrl(url = '') {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname === 'shopee.vn' || parsedUrl.hostname.endsWith('.shopee.vn');
  } catch (error) {
    return false;
  }
}

function formatVnd(value) {
  const amount = Number(value || 0);

  if (!amount) {
    return 'Đang cập nhật';
  }

  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0
  }).format(amount);
}

function formatNumber(value) {
  return new Intl.NumberFormat('vi-VN').format(Number(value || 0));
}

function normalizeFilterText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatRating(value) {
  const rating = Number(value || 0);

  if (!rating) {
    return 'Chưa có rating';
  }

  return `Rating ${rating.toFixed(2)}`;
}

function setText(element, text) {
  element.textContent = text;
}

function setStatus(text, type = 'normal') {
  elements.pageStatus.textContent = text;
  elements.pageStatus.className = `status-pill ${type}`;
}

function showElement(element) {
  element.classList.remove('hidden');
}

function hideElement(element) {
  element.classList.add('hidden');
}

function clearResults() {
  state.lastPayload = null;
  state.lastResults = [];
  state.resultFilter = '';
  state.excludeFilter = '';
  state.sortKey = 'score';
  state.sortDirection = 'desc';
  elements.results.innerHTML = '';
  elements.resultSummary.innerHTML = '';
  if (elements.resultFilterInput) {
    elements.resultFilterInput.value = '';
  }
  if (elements.excludeFilterInput) {
    elements.excludeFilterInput.value = '';
  }
  if (elements.minSoldInput) {
    elements.minSoldInput.value = '';
  }
  if (elements.minScoreInput) {
    elements.minScoreInput.value = '';
  }
  if (elements.onlyHcmCheckbox) {
    elements.onlyHcmCheckbox.checked = false;
  }
  if (elements.filterCount) {
    elements.filterCount.textContent = '0/0 sản phẩm';
  }
  hideElement(elements.resultSummary);
  if (elements.techInfoPanel) { hideElement(elements.techInfoPanel); }
  if (elements.techInfoContent) { elements.techInfoContent.innerHTML = ''; }
  hideElement(elements.resultFilterBox);
  if (elements.scoreGuide) {
    hideElement(elements.scoreGuide);
  }
  updateCacheMeta(0);
  hideError();
}

function showError(message) {
  elements.errorBox.textContent = message;
  showElement(elements.errorBox);
  appendDebugLog('popup', 'Hiển thị lỗi', { message });
}

function hideError() {
  elements.errorBox.textContent = '';
  hideElement(elements.errorBox);
}

function setLoading(isLoading) {
  state.isLoading = isLoading;
  elements.findButton.disabled = isLoading || !state.currentProduct;

  if (isLoading) {
    showElement(elements.loadingState);
    elements.findButton.textContent = 'Đang tìm...';
  } else {
    hideElement(elements.loadingState);
    elements.findButton.textContent = 'Tìm';
  }
}

function renderNoProduct(message) {
  state.currentProduct = null;
  hideElement(elements.currentProduct);
  showElement(elements.emptyState);
  setStatus('Chưa đọc được', 'warning');
  elements.emptyState.querySelector('p').textContent = message || 'Hãy mở đúng trang chi tiết sản phẩm Shopee rồi bấm lại extension.';
  elements.findButton.disabled = true;
  clearResults();
  appendDebugLog('popup', 'Render no product', { message });
}

async function renderCurrentProduct(product) {
  const previousKey = state.currentProduct && state.currentProduct.productKey;
  const nextKey = product && product.productKey;

  state.currentProduct = product;

  if (previousKey && nextKey && previousKey !== nextKey) {
    clearResults();
  }

  hideElement(elements.emptyState);
  showElement(elements.currentProduct);
  setStatus('Đã đọc', 'success');

  elements.currentImage.src = product.image_url || '';
  elements.currentImage.alt = product.name || 'Ảnh sản phẩm đang xem';
  setText(elements.currentName, product.name || 'Không có tên sản phẩm');
  setText(elements.currentProductId, `${product.shopid || '-'} · ${product.itemid || '-'}`);
  setText(elements.currentPrice, formatVnd(product.price_min || product.price));
  setText(elements.currentRating, formatRating(product.rating_star));
  setText(elements.currentSold, `Đã bán ${formatNumber(product.historical_sold)}`);

  elements.findButton.disabled = false;

  appendDebugLog('popup', 'Render current product', {
    productKey: product.productKey,
    name: product.name,
    price: product.price_min || product.price,
    catid: product.catid
  });

  const restored = await loadCachedResultsForCurrentProduct();
  if (!restored) {
    updateCacheMeta(0);
  }
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0] ? tabs[0] : null;
      appendDebugLog('popup', 'Active tab', {
        id: tab && tab.id,
        url: tab && tab.url,
        title: tab && tab.title
      });
      resolve(tab);
    });
  });
}

function getStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function setStorage(payload) {
  return new Promise((resolve) => {
    chrome.storage.local.set(payload, () => resolve());
  });
}

function removeStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}

function getResultCacheKey(productKey) {
  return productKey ? `${RESULT_CACHE_PREFIX}${productKey}` : '';
}

function getCurrentResultCacheKey() {
  return getResultCacheKey(state.currentProduct && state.currentProduct.productKey);
}

function formatSavedTime(timestamp) {
  const t = Number(timestamp || 0);
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 60 * 1000) return 'vừa lưu';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} phút trước`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} giờ trước`;
  return `${Math.floor(diff / 86400000)} ngày trước`;
}

function updateCacheMeta(timestamp, sourceLabel) {
  state.cacheUpdatedAt = Number(timestamp || 0);
  if (!elements.cacheMeta) return;
  if (!state.cacheUpdatedAt) {
    elements.cacheMeta.textContent = 'Chưa có dữ liệu lưu';
    elements.cacheMeta.className = 'cache-meta muted';
    return;
  }
  const age = Date.now() - state.cacheUpdatedAt;
  const prefix = sourceLabel || 'Đã lưu';
  const stale = age > 24 * 60 * 60 * 1000;
  elements.cacheMeta.textContent = `${prefix}: ${formatSavedTime(state.cacheUpdatedAt)}${stale ? ' · nên tìm lại' : ''}`;
  elements.cacheMeta.className = `cache-meta ${stale ? 'warning' : ''}`;
}

async function pruneResultCacheIndex() {
  const stored = await getStorage([RESULT_CACHE_INDEX_KEY]);
  let index = Array.isArray(stored[RESULT_CACHE_INDEX_KEY]) ? stored[RESULT_CACHE_INDEX_KEY] : [];
  const now = Date.now();
  index = index
    .filter((entry) => entry && entry.key && entry.updatedAt && (now - Number(entry.updatedAt)) <= RESULT_CACHE_TTL)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const keep = index.slice(0, RESULT_CACHE_MAX_ITEMS);
  const removeKeys = index.slice(RESULT_CACHE_MAX_ITEMS).map((entry) => entry.key);
  if (removeKeys.length) {
    await removeStorage(removeKeys);
  }
  await setStorage({ [RESULT_CACHE_INDEX_KEY]: keep });
  return keep;
}

function getUiOptionsState() {
  return {
    searchMode: elements.searchModeSelect ? elements.searchModeSelect.value : 'wide',
    returnLimit: elements.returnLimitSelect ? Number(elements.returnLimitSelect.value || 50) : 50
  };
}

function getUiFiltersState() {
  return {
    includeText: state.resultFilter || '',
    excludeText: state.excludeFilter || '',
    minSold: Number(state.minSoldFilter || 0),
    minScore: Number(state.minScoreFilter || 0),
    onlyHcm: !!state.onlyHcmFilter
  };
}

function getUiSortState() {
  return {
    key: state.sortKey || 'score',
    direction: state.sortDirection || 'desc'
  };
}

async function saveCurrentResultCache(reason = 'autosave') {
  const key = getCurrentResultCacheKey();
  if (!key || !state.currentProduct || !state.lastPayload || !Array.isArray(state.lastResults) || !state.lastResults.length) {
    return;
  }
  const updatedAt = Date.now();
  const payload = {
    ...state.lastPayload,
    results: state.lastResults,
    cachedAt: updatedAt
  };
  const record = {
    version: '1.2.1',
    productKey: state.currentProduct.productKey,
    product: state.currentProduct,
    payload,
    filters: getUiFiltersState(),
    sort: getUiSortState(),
    options: getUiOptionsState(),
    updatedAt
  };
  const stored = await getStorage([RESULT_CACHE_INDEX_KEY]);
  const index = Array.isArray(stored[RESULT_CACHE_INDEX_KEY]) ? stored[RESULT_CACHE_INDEX_KEY] : [];
  const nextIndex = [
    { key, productKey: state.currentProduct.productKey, name: state.currentProduct.name || '', updatedAt },
    ...index.filter((entry) => entry && entry.key !== key)
  ].slice(0, RESULT_CACHE_MAX_ITEMS + 10);
  await setStorage({ [key]: record, [RESULT_CACHE_INDEX_KEY]: nextIndex });
  updateCacheMeta(updatedAt, 'Đã lưu');
  pruneResultCacheIndex().catch(() => {});
  appendDebugLog('cache', 'Đã lưu kết quả theo sản phẩm', { reason, key, results: state.lastResults.length });
}

async function loadCachedResultsForCurrentProduct() {
  const key = getCurrentResultCacheKey();
  if (!key) return false;
  const stored = await getStorage([key]);
  const record = stored[key];
  if (!record || !record.payload || !Array.isArray(record.payload.results)) {
    updateCacheMeta(0);
    return false;
  }
  if (Date.now() - Number(record.updatedAt || 0) > RESULT_CACHE_TTL) {
    await removeStorage([key]);
    updateCacheMeta(0);
    appendDebugLog('cache', 'Cache kết quả đã quá hạn và bị xóa', { key });
    return false;
  }
  renderResults(record.payload, {
    fromCache: true,
    save: false,
    cacheState: record,
    cacheUpdatedAt: record.updatedAt
  });
  appendDebugLog('cache', 'Đã khôi phục kết quả đã lưu', { key, results: record.payload.results.length, updatedAt: record.updatedAt });
  return true;
}

async function clearCurrentResultCache() {
  const key = getCurrentResultCacheKey();
  if (!key) return;
  const stored = await getStorage([RESULT_CACHE_INDEX_KEY]);
  const index = Array.isArray(stored[RESULT_CACHE_INDEX_KEY]) ? stored[RESULT_CACHE_INDEX_KEY] : [];
  await removeStorage([key]);
  await setStorage({ [RESULT_CACHE_INDEX_KEY]: index.filter((entry) => entry && entry.key !== key) });
  clearResults();
  updateCacheMeta(0);
  appendDebugLog('cache', 'Đã xóa kết quả đã lưu của sản phẩm hiện tại', { key });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    appendDebugLog('popup', 'Gửi message tới tab', { tabId, message });

    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        const error = chrome.runtime.lastError.message;
        appendDebugLog('popup', 'tabs.sendMessage lỗi', { error });
        resolve({ ok: false, error });
        return;
      }

      appendDebugLog('popup', 'tabs.sendMessage response', response || {});
      resolve(response || { ok: false, error: 'Không có phản hồi từ content script.' });
    });
  });
}

function sendMessageToBackground(message) {
  return new Promise((resolve) => {
    appendDebugLog('popup', 'Gửi message tới background', { messageType: message && message.type, tabId: message && message.tabId });

    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        const error = chrome.runtime.lastError.message;
        appendDebugLog('popup', 'runtime.sendMessage lỗi', { error });
        resolve({ ok: false, error });
        return;
      }

      appendDebugLog('popup', 'runtime.sendMessage response', {
        ok: response && response.ok,
        resultCount: response && response.results && response.results.length,
        keywords: response && response.keywords,
        totalCandidates: response && response.totalCandidates,
        error: response && response.error
      });
      resolve(response || { ok: false, error: 'Không có phản hồi từ background.' });
    });
  });
}

async function fetchProductViaPageContext(idsFromUrl) {
  if (!state.activeTab || !state.activeTab.id || !idsFromUrl) {
    return { ok: false, error: 'Thiếu tab hoặc shopId/itemId để đọc sản phẩm qua page-context.' };
  }

  appendDebugLog('popup', 'Thử đọc sản phẩm qua background page-context', {
    tabId: state.activeTab.id,
    idsFromUrl
  });

  return sendMessageToBackground({
    type: 'GET_CURRENT_PRODUCT_PAGE_FETCH',
    tabId: state.activeTab.id,
    shopId: idsFromUrl.shopId,
    itemId: idsFromUrl.itemId,
    sourceUrl: state.activeTab.url
  });
}

function injectContentScript(tabId) {
  return new Promise((resolve) => {
    appendDebugLog('popup', 'Inject passive-capture.js + content.js', { tabId });

    chrome.scripting.executeScript({
      target: { tabId },
      files: ['passive-capture.js'],
      world: 'MAIN'
    }, () => {
      if (chrome.runtime.lastError) {
        appendDebugLog('popup', 'Inject passive-capture.js cảnh báo', {
          error: chrome.runtime.lastError.message
        });
        // Không return ở đây vì content.js vẫn có thể chạy bằng page-context fallback.
      }

      chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      }, () => {
        if (chrome.runtime.lastError) {
          const error = chrome.runtime.lastError.message;
          appendDebugLog('popup', 'Inject content.js lỗi', { error });
          resolve({ ok: false, error });
          return;
        }

        appendDebugLog('popup', 'Inject content.js thành công', { tabId });
        resolve({ ok: true });
      });
    });
  });
}

async function refreshProductFromActiveTab(idsFromUrl) {
  if (!state.activeTab || !state.activeTab.id) {
    return { ok: false, error: 'Không tìm thấy tab đang mở.' };
  }

  let response = await sendMessageToTab(state.activeTab.id, { type: 'GET_CURRENT_PRODUCT' });

  if (response && response.ok) {
    return response;
  }

  appendDebugLog('popup', 'Không nhận được content script, thử inject lại', { firstResponse: response });
  const injectResult = await injectContentScript(state.activeTab.id);

  if (!injectResult.ok) {
    return injectResult;
  }

  response = await sendMessageToTab(state.activeTab.id, { type: 'GET_CURRENT_PRODUCT' });

  if (response && response.ok) {
    return response;
  }

  appendDebugLog('popup', 'Content vẫn lỗi, chuyển sang page-context fallback', {
    response,
    idsFromUrl
  });

  return fetchProductViaPageContext(idsFromUrl);
}

async function loadCurrentProduct() {
  setStatus('Đang kiểm tra...', 'normal');
  hideError();

  state.activeTab = await getActiveTab();

  if (!state.activeTab || !state.activeTab.url) {
    renderNoProduct('Không đọc được tab hiện tại.');
    return;
  }

  if (!isShopeeUrl(state.activeTab.url)) {
    renderNoProduct('Tab hiện tại không phải shopee.vn.');
    return;
  }

  const idsFromUrl = parseShopeeProductIds(state.activeTab.url);
  appendDebugLog('popup', 'Parse URL tab hiện tại', {
    url: state.activeTab.url,
    idsFromUrl
  });

  if (!idsFromUrl) {
    renderNoProduct('URL hiện tại không có dạng sản phẩm Shopee: -i.shopId.itemId hoặc /product/shopId/itemId.');
    return;
  }

  const response = await refreshProductFromActiveTab(idsFromUrl);

  if (response && response.ok && response.product) {
    await renderCurrentProduct(response.product);
    return;
  }

  const stored = await getStorage([STORAGE_PRODUCT_KEY, STORAGE_STATUS_KEY]);
  const product = stored[STORAGE_PRODUCT_KEY];
  const status = stored[STORAGE_STATUS_KEY];

  appendDebugLog('popup', 'Fallback đọc storage sau khi refresh fail', {
    response,
    hasProduct: Boolean(product),
    status
  });

  if (product && product.productKey === idsFromUrl.productKey) {
    await renderCurrentProduct(product);
    return;
  }

  renderNoProduct((response && response.error) || (status && status.error) || 'Không đọc được sản phẩm hiện tại từ Shopee API.');
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  if (typeof text === 'string') {
    element.textContent = text;
  }

  return element;
}

function renderResultSummary(payload) {
  const keywordsText = Array.isArray(payload.keywords) && payload.keywords.length ? payload.keywords.join(' | ') : 'không rõ';
  const searchDebug = Array.isArray(payload.searchDebug) ? payload.searchDebug : [];
  const searchText = searchDebug.map((item) => `${item.keyword}: ${item.rawCount}${item.ok ? '' : ' lỗi'}`).join(' · ');
  const returnedCount = Array.isArray(payload.results) ? payload.results.length : 0;
  const totalCandidates = Number(payload.totalCandidates || 0);
  const excludedCount = Number(payload.excludedShopCount || 0);
  const excludedPriceCount = Number(payload.excludedPriceCount || (payload.priceFilter && payload.priceFilter.excludedCount) || 0);
  const hcmBonus = payload.hcmLocationBonus && payload.hcmLocationBonus.enabled ? Number(payload.hcmLocationBonus.points || 5) : 0;

  elements.resultSummary.innerHTML = '';
  const chips = [
    ['Kết quả', formatNumber(returnedCount)],
    ['Ứng viên', formatNumber(totalCandidates)],
    ['Loại shop', formatNumber(excludedCount)],
    ['Lệch giá', formatNumber(excludedPriceCount)]
  ];
  if (hcmBonus) {
    chips.push(['HCM', `+${hcmBonus}`]);
  }

  chips.forEach(([label, value]) => {
    const chip = createElement('span', 'summary-chip');
    chip.appendChild(createElement('span', 'summary-chip-label', label));
    chip.appendChild(createElement('strong', '', value));
    elements.resultSummary.appendChild(chip);
  });
  showElement(elements.resultSummary);

  if (elements.techInfoPanel && elements.techInfoContent) {
    elements.techInfoContent.innerHTML = '';
    const techLines = [
      `Keyword: ${keywordsText}`,
      `Ứng viên hợp lệ: ${formatNumber(totalCandidates)} · Trả về: ${formatNumber(returnedCount)}`,
      `Đã loại shop nội bộ: ${formatNumber(excludedCount)} · Đã loại lệch giá >50%: ${formatNumber(excludedPriceCount)}${hcmBonus ? ` · Ưu tiên HCM: +${hcmBonus} điểm` : ''}`,
      searchText ? `API/passive: ${searchText}` : ''
    ].filter(Boolean);

    techLines.forEach((text) => {
      elements.techInfoContent.appendChild(createElement('div', 'tech-info-line', text));
    });
    showElement(elements.techInfoPanel);
  }
}

function getResultSearchText(item) {
  return normalizeFilterText([
    item.name,
    item.shop_name,
    item.shop_location,
    item.price_min || item.price,
    item.score,
    item.rating_star,
    item.historical_sold
  ].join(' '));
}

function splitFilterTerms(rawValue) {
  return String(rawValue || '')
    .split(/[\n,;|]+/)
    .map((part) => normalizeFilterText(part))
    .filter(Boolean);
}

function phraseMatched(haystack, phrase) {
  const tokens = normalizeFilterText(phrase).split(' ').filter(Boolean);

  if (!tokens.length) {
    return false;
  }

  return tokens.every((token) => haystack.includes(token));
}

function isHcmLocation(item) {
  const locationText = normalizeFilterText(getLocationText(item));
  return locationText.includes('ho chi minh') || locationText.includes('hcm') || locationText.includes('tp hcm') || locationText.includes('tphcm');
}

function getFilteredResults() {
  const includeFilter = normalizeFilterText(state.resultFilter);
  const includeTokens = includeFilter.split(' ').filter(Boolean);
  const excludeTerms = splitFilterTerms(state.excludeFilter);
  const minSold = Number(state.minSoldFilter || 0);
  const minScore = Number(state.minScoreFilter || 0);
  const onlyHcm = !!state.onlyHcmFilter;

  return state.lastResults.filter((item) => {
    const haystack = getResultSearchText(item);
    const passInclude = !includeTokens.length || includeTokens.every((token) => haystack.includes(token));
    const hitExclude = excludeTerms.some((term) => phraseMatched(haystack, term));
    const sold = Number(item.historical_sold || item.sold || 0);
    const score = Number(item.score || 0);
    const passSold = !minSold || sold >= minSold;
    const passScore = !minScore || score >= minScore;
    const passHcm = !onlyHcm || isHcmLocation(item);

    return passInclude && !hitExclude && passSold && passScore && passHcm;
  });
}

function updateFilterCount(filteredCount, totalCount) {
  if (!elements.filterCount) {
    return;
  }

  elements.filterCount.textContent = `${formatNumber(filteredCount)}/${formatNumber(totalCount)} sản phẩm`;
}

function createTableCell(className, text) {
  const cell = document.createElement('td');

  if (className) {
    cell.className = className;
  }

  if (typeof text === 'string') {
    cell.textContent = text;
  }

  return cell;
}

function openResultItem(item) {
  if (item && item.url) {
    appendDebugLog('popup', 'Mở sản phẩm kết quả', { url: item.url, name: item.name, score: item.score });
    chrome.tabs.create({ url: item.url });
  }
}

function scorePart(value, decimals = 1) {
  const number = Number(value || 0);

  if (!Number.isFinite(number)) {
    return '0';
  }

  if (Number.isInteger(number)) {
    return String(number);
  }

  return number.toFixed(decimals);
}

function renderScorePartCell(className, value, maxValue, subText) {
  const cell = createTableCell(className || 'td-score-part');
  const main = createElement('span', 'score-number', scorePart(value));
  const sub = createElement('div', 'score-sub', `/${maxValue}${subText ? ` · ${subText}` : ''}`);
  cell.appendChild(main);
  cell.appendChild(sub);
  return cell;
}

function getSortableNumber(item, key) {
  if (!item) {
    return 0;
  }

  if (key === 'price') {
    return Number(item.price_min || item.price || 0);
  }

  if (key === 'score') {
    return Number(item.score || 0);
  }

  if (key === 'rating') {
    return Number(item.rating_star || 0);
  }

  if (key === 'sold') {
    return Number(item.historical_sold || item.sold || 0);
  }

  return 0;
}

function getSortedResults(results) {
  const sorted = [...results];
  const direction = state.sortDirection === 'asc' ? 1 : -1;
  const key = state.sortKey || 'score';

  sorted.sort((a, b) => {
    const av = getSortableNumber(a, key);
    const bv = getSortableNumber(b, key);

    if (av === bv) {
      return Number(b.score || 0) - Number(a.score || 0);
    }

    return (av - bv) * direction;
  });

  return sorted;
}

function sortLabel(key, label) {
  if (state.sortKey !== key) {
    return label;
  }

  return `${label} ${state.sortDirection === 'asc' ? '↑' : '↓'}`;
}

function makeHeaderCell(label, sortKey) {
  const th = document.createElement('th');
  th.textContent = sortKey ? sortLabel(sortKey, label) : label;

  if (sortKey) {
    th.className = `sortable ${state.sortKey === sortKey ? 'active' : ''}`;
    th.title = `Bấm để sort theo ${label.toLowerCase()}`;
    th.addEventListener('click', () => handleSortHeaderClick(sortKey));
  }

  return th;
}

function handleSortHeaderClick(sortKey) {
  if (state.sortKey === sortKey) {
    state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortKey = sortKey;
    state.sortDirection = 'desc';
  }

  appendDebugLog('popup', 'Sort bảng kết quả', {
    sortKey: state.sortKey,
    sortDirection: state.sortDirection
  });

  renderResultsTable();
}

function getLocationText(item) {
  const parts = [];
  if (item.shop_name) {
    parts.push(item.shop_name);
  }
  if (item.shop_location) {
    parts.push(item.shop_location);
  }
  return parts.join(' · ') || 'Không rõ';
}

function renderGroupScoreText(item) {
  const detail = item.scoreDetail || {};
  return [
    `Tên ${scorePart(detail.nameScore)}/35`,
    `Cat ${scorePart(detail.catScore)}/15`,
    `Rating ${scorePart(detail.ratingScore)}/10`,
    `Bán ${scorePart(detail.soldScore)}/25`,
    `Giá ${scorePart(detail.priceScore)}/10`,
    `KV ${scorePart(detail.locationScore)}/5`,
    detail.salesCapApplied ? `Trần bán ${scorePart(detail.salesCapScore)}` : ''
  ].filter(Boolean).join(' · ');
}

function getCompetitionLabel(score) {
  const n = Number(score || 0);
  if (n >= 80) return 'Mạnh';
  if (n >= 70) return 'Khá mạnh';
  if (n >= 60) return 'Trung bình';
  return 'Tham khảo';
}

function formatRatingValue(value) {
  const rating = Number(value || 0);
  if (!Number.isFinite(rating) || rating <= 0) {
    return '-';
  }
  return rating.toFixed(2).replace(/(\.\d)0$/, '$1').replace(/\.00$/, '');
}

function getRatingCountText(item) {
  const count = Number(item && item.rating_count || 0);
  if (!Number.isFinite(count) || count <= 0) {
    return '';
  }
  return `${formatNumber(count)} đánh giá`;
}

function renderResultsTable() {
  const filteredResults = getFilteredResults();
  const sortedResults = getSortedResults(filteredResults);
  const totalResults = state.lastResults.length;
  elements.results.innerHTML = '';
  updateFilterCount(sortedResults.length, totalResults);

  if (!totalResults) {
    const empty = createElement('div', 'no-results', 'Không tìm thấy sản phẩm tương đồng. Mở phần debug ở cuối giao diện để xem keyword/API trả về gì.');
    elements.results.appendChild(empty);
    return;
  }

  if (!sortedResults.length) {
    const empty = createElement('div', 'no-results', 'Không có sản phẩm nào khớp bộ lọc hiện tại. Bạn thử xóa bớt từ khóa giữ lại hoặc loại trừ.');
    elements.results.appendChild(empty);
    return;
  }

  const table = createElement('table', 'results-table data-table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  headerRow.appendChild(makeHeaderCell('Ảnh'));
  headerRow.appendChild(makeHeaderCell('Tên sản phẩm'));
  headerRow.appendChild(makeHeaderCell('Giá', 'price'));
  headerRow.appendChild(makeHeaderCell('Đánh giá', 'rating'));
  headerRow.appendChild(makeHeaderCell('Điểm nhóm', 'score'));
  headerRow.appendChild(makeHeaderCell('Lượt bán', 'sold'));
  thead.appendChild(headerRow);

  const tbody = document.createElement('tbody');

  sortedResults.forEach((item) => {
    const row = document.createElement('tr');
    row.className = 'result-row';

    const imageCell = createTableCell('td-image');
    const img = createElement('img', 'result-image');
    img.src = item.image_url || '';
    img.alt = item.name || 'Ảnh sản phẩm';
    imageCell.appendChild(img);

    const nameCell = createTableCell('td-name');
    const nameLink = createElement('a', 'table-product-name product-link', item.name || 'Không có tên');
    nameLink.href = item.url || '#';
    nameLink.target = '_blank';
    nameLink.rel = 'noopener noreferrer';
    nameLink.title = 'Bấm để mở sản phẩm trong tab mới';
    nameLink.addEventListener('click', (event) => {
      event.stopPropagation();
      appendDebugLog('popup', 'Mở sản phẩm từ tên', { url: item.url, name: item.name, score: item.score });
    });
    nameCell.appendChild(nameLink);

    const priceCell = createTableCell('td-price');
    const price = createElement('div', 'result-price', formatVnd(item.price_min || item.price));
    priceCell.appendChild(price);

    const ratingCell = createTableCell('td-rating');
    const ratingMain = createElement('div', 'rating-main', formatRatingValue(item.rating_star));
    const ratingSubText = getRatingCountText(item);
    ratingCell.appendChild(ratingMain);
    if (ratingSubText) {
      ratingCell.appendChild(createElement('div', 'rating-sub', ratingSubText));
    }

    const scoreCell = createTableCell('td-score-total');
    scoreCell.title = renderGroupScoreText(item);
    const totalMain = createElement('div', 'score-total-main', String(item.score || 0));
    const label = createElement('div', `score-label score-label-${String(getCompetitionLabel(item.score)).toLowerCase().replace(/\s+/g, '-')}`, getCompetitionLabel(item.score));
    const shopName = createElement('div', 'score-shop', item.shop_name || item.shopName || item.shopname || '-');
    const place = createElement('div', 'score-place', getLocationText(item).split(' · ').pop() || '-');
    scoreCell.appendChild(totalMain);
    scoreCell.appendChild(label);
    scoreCell.appendChild(shopName);
    scoreCell.appendChild(place);

    const soldCell = createTableCell('td-sold', formatNumber(item.historical_sold || item.sold || 0));

    row.appendChild(imageCell);
    row.appendChild(nameCell);
    row.appendChild(priceCell);
    row.appendChild(ratingCell);
    row.appendChild(scoreCell);
    row.appendChild(soldCell);

    tbody.appendChild(row);
  });

  table.appendChild(thead);
  table.appendChild(tbody);
  elements.results.appendChild(table);
}
function renderResults(payload, options = {}) {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const cacheState = options.cacheState || null;
  state.lastPayload = payload;
  state.lastResults = results;

  if (cacheState) {
    state.resultFilter = cacheState.filters && cacheState.filters.includeText ? cacheState.filters.includeText : '';
    state.excludeFilter = cacheState.filters && cacheState.filters.excludeText ? cacheState.filters.excludeText : '';
    state.minSoldFilter = cacheState.filters && cacheState.filters.minSold ? Number(cacheState.filters.minSold) : 0;
    state.minScoreFilter = cacheState.filters && cacheState.filters.minScore ? Number(cacheState.filters.minScore) : 0;
    state.onlyHcmFilter = !!(cacheState.filters && cacheState.filters.onlyHcm);
    state.sortKey = cacheState.sort && cacheState.sort.key ? cacheState.sort.key : 'score';
    state.sortDirection = cacheState.sort && cacheState.sort.direction ? cacheState.sort.direction : 'desc';
    if (elements.searchModeSelect && cacheState.options && cacheState.options.searchMode) {
      elements.searchModeSelect.value = cacheState.options.searchMode;
    }
    if (elements.returnLimitSelect && cacheState.options && cacheState.options.returnLimit) {
      elements.returnLimitSelect.value = String(cacheState.options.returnLimit);
    }
  } else {
    state.resultFilter = '';
    state.excludeFilter = '';
    state.minSoldFilter = 0;
    state.minScoreFilter = 0;
    state.onlyHcmFilter = false;
    state.sortKey = 'score';
    state.sortDirection = 'desc';
  }

  if (elements.resultFilterInput) {
    elements.resultFilterInput.value = state.resultFilter;
  }
  if (elements.excludeFilterInput) {
    elements.excludeFilterInput.value = state.excludeFilter;
  }
  if (elements.minSoldInput) {
    elements.minSoldInput.value = state.minSoldFilter ? String(state.minSoldFilter) : '';
  }
  if (elements.minScoreInput) {
    elements.minScoreInput.value = state.minScoreFilter ? String(state.minScoreFilter) : '';
  }
  if (elements.onlyHcmCheckbox) {
    elements.onlyHcmCheckbox.checked = !!state.onlyHcmFilter;
  }

  renderResultSummary(payload);

  if (results.length) {
    showElement(elements.resultFilterBox);
    if (elements.scoreGuide) {
      showElement(elements.scoreGuide);
    }
  } else {
    hideElement(elements.resultFilterBox);
    if (elements.scoreGuide) {
      hideElement(elements.scoreGuide);
    }
  }

  renderResultsTable();
  updateCacheMeta(options.cacheUpdatedAt || payload.cachedAt || Date.now(), options.fromCache ? 'Đã khôi phục' : 'Đã lưu');
  if (options.save !== false) {
    saveCurrentResultCache('render_results').catch(() => {});
  }
}

function handleResultFilterInput() {
  state.resultFilter = elements.resultFilterInput ? elements.resultFilterInput.value : '';
  state.excludeFilter = elements.excludeFilterInput ? elements.excludeFilterInput.value : '';
  state.minSoldFilter = elements.minSoldInput ? Number(elements.minSoldInput.value || 0) : 0;
  state.minScoreFilter = elements.minScoreInput ? Number(elements.minScoreInput.value || 0) : 0;
  state.onlyHcmFilter = elements.onlyHcmCheckbox ? !!elements.onlyHcmCheckbox.checked : false;
  appendDebugLog('popup', 'Lọc text kết quả', {
    filter: state.resultFilter,
    excludeFilter: state.excludeFilter,
    minSold: state.minSoldFilter,
    minScore: state.minScoreFilter,
    onlyHcm: state.onlyHcmFilter,
    totalResults: state.lastResults.length,
    filteredResults: getFilteredResults().length
  });
  renderResultsTable();
  saveCurrentResultCache('filter').catch(() => {});
}

function clearResultFilter() {
  state.resultFilter = '';
  state.excludeFilter = '';
  state.minSoldFilter = 0;
  state.minScoreFilter = 0;
  state.onlyHcmFilter = false;
  if (elements.resultFilterInput) {
    elements.resultFilterInput.value = '';
    elements.resultFilterInput.focus();
  }
  if (elements.excludeFilterInput) {
    elements.excludeFilterInput.value = '';
  }
  if (elements.minSoldInput) {
    elements.minSoldInput.value = '';
  }
  if (elements.minScoreInput) {
    elements.minScoreInput.value = '';
  }
  if (elements.onlyHcmCheckbox) {
    elements.onlyHcmCheckbox.checked = false;
  }
  renderResultsTable();
  saveCurrentResultCache('clear_filter').catch(() => {});
}

async function handleFindButtonClick() {
  if (!state.currentProduct || state.isLoading) {
    return;
  }

  clearResults();
  setLoading(true);
  appendDebugLog('popup', 'Bấm nút tìm sản phẩm tương đồng', {
    productName: state.currentProduct.name,
    productKey: state.currentProduct.productKey
  });

  try {
    const response = await sendMessageToBackground({
      type: 'FIND_SIMILAR_PRODUCTS',
      tabId: state.activeTab && state.activeTab.id,
      product: state.currentProduct,
      options: {
        searchMode: elements.searchModeSelect ? elements.searchModeSelect.value : 'wide',
        returnLimit: elements.returnLimitSelect ? Number(elements.returnLimitSelect.value || 50) : 50
      }
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'Không tìm được sản phẩm tương đồng.');
    }

    renderResults(response);
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    setLoading(false);
    renderDebugLogs();
  }
}

function formatDebugEntry(entry, index) {
  const data = entry && entry.data !== undefined ? JSON.stringify(entry.data, null, 2) : '';
  return `#${index + 1} [${entry.time}] ${entry.scope}: ${entry.message}\n${data}`;
}

async function renderDebugLogs() {
  const stored = await getStorage([STORAGE_DEBUG_KEY]);
  const logs = Array.isArray(stored[STORAGE_DEBUG_KEY]) ? stored[STORAGE_DEBUG_KEY] : [];

  elements.debugCount.textContent = `${logs.length} dòng`;
  elements.debugOutput.textContent = logs.map(formatDebugEntry).join('\n\n');
  elements.debugOutput.scrollTop = elements.debugOutput.scrollHeight;
}

async function copyDebugLogs() {
  const stored = await getStorage([STORAGE_DEBUG_KEY]);
  const logs = Array.isArray(stored[STORAGE_DEBUG_KEY]) ? stored[STORAGE_DEBUG_KEY] : [];
  const text = logs.map(formatDebugEntry).join('\n\n');

  try {
    await navigator.clipboard.writeText(text || 'Không có debug log.');
    elements.copyDebugButton.textContent = 'Đã copy';
    setTimeout(() => {
      elements.copyDebugButton.textContent = 'Copy log';
    }, 1200);
  } catch (error) {
    showError(`Không copy được debug log: ${error.message || String(error)}`);
  }
}

async function clearDebugLogs() {
  await setStorage({ [STORAGE_DEBUG_KEY]: [] });
  await renderDebugLogs();
  appendDebugLog('popup', 'Đã xóa debug log', {});
}

function toggleDebugPanel() {
  state.debugVisible = !state.debugVisible;

  if (state.debugVisible) {
    showElement(elements.debugPanel);
    elements.toggleDebugButton.textContent = 'Ẩn debug';
    renderDebugLogs();
  } else {
    hideElement(elements.debugPanel);
    elements.toggleDebugButton.textContent = 'Hiện debug';
  }
}


function scheduleLoadCurrentProduct(reason) {
  if (state.autoLoadTimer) {
    clearTimeout(state.autoLoadTimer);
  }

  state.autoLoadTimer = setTimeout(() => {
    appendDebugLog('popup', 'Tự cập nhật theo tab đang mở', { reason });
    loadCurrentProduct().catch((error) => {
      appendDebugLog('popup', 'Tự cập nhật tab lỗi', { reason, error: error.message || String(error) });
    });
  }, 250);
}

function bindTabWatchers() {
  if (chrome.tabs && chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(() => {
      scheduleLoadCurrentProduct('tabs.onActivated');
    });
  }

  if (chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' && tab && tab.active) {
        scheduleLoadCurrentProduct('tabs.onUpdated.complete');
      }
    });
  }
}

function bindEvents() {
  elements.findButton.addEventListener('click', handleFindButtonClick);
  elements.resultFilterInput.addEventListener('input', handleResultFilterInput);
  elements.excludeFilterInput.addEventListener('input', handleResultFilterInput);
  if (elements.minSoldInput) elements.minSoldInput.addEventListener('input', handleResultFilterInput);
  if (elements.minScoreInput) elements.minScoreInput.addEventListener('input', handleResultFilterInput);
  if (elements.onlyHcmCheckbox) elements.onlyHcmCheckbox.addEventListener('change', handleResultFilterInput);
  elements.clearFilterButton.addEventListener('click', clearResultFilter);
  elements.toggleDebugButton.addEventListener('click', toggleDebugPanel);
  elements.copyDebugButton.addEventListener('click', copyDebugLogs);
  elements.clearDebugButton.addEventListener('click', clearDebugLogs);
  if (elements.clearCachedResultsButton) {
    elements.clearCachedResultsButton.addEventListener('click', clearCurrentResultCache);
  }
  if (elements.searchModeSelect) {
    elements.searchModeSelect.addEventListener('change', () => saveCurrentResultCache('search_mode').catch(() => {}));
  }
  if (elements.returnLimitSelect) {
    elements.returnLimitSelect.addEventListener('change', () => saveCurrentResultCache('return_limit').catch(() => {}));
  }
}

async function init() {
  initElements();
  bindEvents();
  bindTabWatchers();
  appendDebugLog('popup', 'Popup loaded', { version: '1.2.1-table-polish' });
  await loadCurrentProduct();
  await renderDebugLogs();
}

document.addEventListener('DOMContentLoaded', init);
