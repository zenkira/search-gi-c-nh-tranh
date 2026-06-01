(() => {
  'use strict';

  if (window.__SHOPEE_PRICE_FINDER_CONTENT_LOADED__) {
    return;
  }
  window.__SHOPEE_PRICE_FINDER_CONTENT_LOADED__ = true;

  const STORAGE_PRODUCT_KEY = 'currentProduct';
  const STORAGE_STATUS_KEY = 'currentProductStatus';
  const STORAGE_DEBUG_KEY = 'debugLogs';
  const MAX_DEBUG_LOGS = 220;

  const ITEM_URL_PATTERNS = [
    /(?:^|[/-])i\.(\d+)\.(\d+)(?=$|[/?#&])/,
    /\/product\/(\d+)\/(\d+)(?=$|[/?#&])/
  ];

  let lastHandledUrl = '';
  let lastFetchedKey = '';
  let isFetching = false;

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

    try {
      chrome.storage.local.get([STORAGE_DEBUG_KEY], (result) => {
        const currentLogs = Array.isArray(result && result[STORAGE_DEBUG_KEY]) ? result[STORAGE_DEBUG_KEY] : [];
        const nextLogs = currentLogs.concat(entry).slice(-MAX_DEBUG_LOGS);
        chrome.storage.local.set({ [STORAGE_DEBUG_KEY]: nextLogs });
      });
    } catch (error) {
      console.warn('[SPF:content] Không lưu được debug log:', error);
    }
  }

  function parseShopeeProductIds(url = window.location.href) {
    const textUrl = String(url || '');

    for (const pattern of ITEM_URL_PATTERNS) {
      const match = textUrl.match(pattern);
      if (match) {
        return {
          shopId: Number(match[1]),
          itemId: Number(match[2]),
          productKey: `${match[1]}_${match[2]}`,
          matchedPattern: String(pattern)
        };
      }
    }

    return null;
  }

  function toVnd(rawPrice) {
    const value = Number(rawPrice || 0);
    if (!Number.isFinite(value) || value <= 0) {
      return 0;
    }

    // API Shopee thường trả VND * 100000, nhưng fallback DOM/passive có thể đã là VND thật.
    return Math.round(value > 1000000 ? value / 100000 : value);
  }

  function getRatingCount(itemRating) {
    if (!itemRating || !Array.isArray(itemRating.rating_count)) {
      return 0;
    }

    return Number(itemRating.rating_count[0] || 0);
  }

  function buildImageUrl(imageId) {
    if (!imageId) {
      return '';
    }

    if (/^https?:\/\//i.test(String(imageId))) {
      return String(imageId);
    }

    return `https://cf.shopee.vn/file/${imageId}`;
  }

  function normalizeItem(rawItem, sourceUrl) {
    const firstImage = Array.isArray(rawItem.images) ? rawItem.images[0] : rawItem.image;
    const rating = rawItem.item_rating || {};

    return {
      itemid: Number(rawItem.itemid || 0),
      shopid: Number(rawItem.shopid || 0),
      name: String(rawItem.name || '').trim(),
      price: toVnd(rawItem.price),
      price_min: toVnd(rawItem.price_min || rawItem.price),
      price_max: toVnd(rawItem.price_max || rawItem.price),
      discount: rawItem.discount || '',
      historical_sold: Number(rawItem.historical_sold || 0),
      catid: Number(rawItem.catid || 0),
      image: firstImage || '',
      image_url: buildImageUrl(firstImage),
      images: Array.isArray(rawItem.images) ? rawItem.images : [],
      rating_star: Number(rating.rating_star || 0),
      rating_count: getRatingCount(rating),
      description: String(rawItem.description || ''),
      sourceUrl,
      productKey: `${rawItem.shopid}_${rawItem.itemid}`,
      fetchedAt: Date.now()
    };
  }

  function saveStatus(status) {
    const payload = {
      ...status,
      updatedAt: Date.now(),
      url: window.location.href
    };

    appendDebugLog('content', 'Lưu trạng thái currentProductStatus', payload);

    return chrome.storage.local.set({
      [STORAGE_STATUS_KEY]: payload
    });
  }

  async function clearCurrentProduct(message) {
    appendDebugLog('content', 'Xóa currentProduct', { message, url: window.location.href });

    await chrome.storage.local.remove(STORAGE_PRODUCT_KEY);
    await saveStatus({
      isProductPage: false,
      message: message || 'Trang hiện tại không phải trang sản phẩm Shopee.'
    });
  }


  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      try {
        appendDebugLog('content', 'Gửi message tới background', {
          messageType: message && message.type,
          shopId: message && message.shopId,
          itemId: message && message.itemId
        });

        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            const error = chrome.runtime.lastError.message;
            appendDebugLog('content', 'runtime.sendMessage lỗi', { error });
            resolve({ ok: false, error });
            return;
          }

          appendDebugLog('content', 'runtime.sendMessage response', {
            ok: response && response.ok,
            hasProduct: Boolean(response && response.product),
            error: response && response.error
          });
          resolve(response || { ok: false, error: 'Không có phản hồi từ background.' });
        });
      } catch (error) {
        appendDebugLog('content', 'runtime.sendMessage exception', {
          error: error.message || String(error)
        });
        resolve({ ok: false, error: error.message || String(error) });
      }
    });
  }

  async function fetchCurrentProductByPageContext(shopId, itemId, directError) {
    appendDebugLog('content', 'Thử đọc sản phẩm bằng page-context fallback', {
      shopId,
      itemId,
      directError
    });

    const response = await sendRuntimeMessage({
      type: 'PAGE_FETCH_CURRENT_PRODUCT_FROM_CONTENT',
      shopId,
      itemId,
      sourceUrl: window.location.href,
      directError
    });

    if (response && response.ok && response.product) {
      appendDebugLog('content', 'Page-context fallback đọc được sản phẩm', {
        productKey: response.product.productKey,
        name: response.product.name,
        price: response.product.price_min || response.product.price
      });
      return response.product;
    }

    throw new Error((response && response.error) || 'Page-context fallback không đọc được sản phẩm.');
  }

  async function fetchCurrentProduct(shopId, itemId) {
    const apiUrl = `https://shopee.vn/api/v4/item/get?itemid=${encodeURIComponent(itemId)}&shopid=${encodeURIComponent(shopId)}`;

    appendDebugLog('content', 'Bắt đầu gọi item API bằng content fetch', { apiUrl, shopId, itemId });

    const startedAt = Date.now();

    try {
      const response = await fetch(apiUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'x-api-source': 'pc'
        }
      });

      const elapsedMs = Date.now() - startedAt;
      appendDebugLog('content', 'Item API content-fetch response status', {
        status: response.status,
        ok: response.ok,
        elapsedMs,
        contentType: response.headers.get('content-type')
      });

      if (!response.ok) {
        let bodyText = '';
        try {
          bodyText = await response.text();
        } catch (error) {
          bodyText = `Không đọc được response body: ${error.message}`;
        }

        appendDebugLog('content', 'Item API content-fetch lỗi HTTP', {
          status: response.status,
          bodyPreview: bodyText.slice(0, 500)
        });

        if (response.status === 403 || response.status === 429) {
          return fetchCurrentProductByPageContext(shopId, itemId, `HTTP ${response.status}: ${bodyText.slice(0, 180)}`);
        }

        throw new Error(`Không gọi được Shopee item API. HTTP ${response.status}`);
      }

      const json = await response.json();
      appendDebugLog('content', 'Item API JSON keys', {
        rootKeys: Object.keys(json || {}),
        dataKeys: Object.keys((json && json.data) || {}),
        hasItem: Boolean(json && json.data && json.data.item),
        error: json && json.error,
        errorMsg: json && json.error_msg
      });

      const rawItem = json && json.data && json.data.item;

      if (!rawItem || !rawItem.itemid || !rawItem.shopid) {
        appendDebugLog('content', 'Item API không có item hợp lệ', {
          jsonPreview: safeJson(json)
        });
        throw new Error('Shopee item API không trả về dữ liệu sản phẩm hợp lệ. Có thể Shopee chặn API hoặc URL không đúng item.');
      }

      const product = normalizeItem(rawItem, window.location.href);
      appendDebugLog('content', 'Đọc được sản phẩm hiện tại bằng content fetch', {
        productKey: product.productKey,
        name: product.name,
        price: product.price,
        catid: product.catid,
        rating_star: product.rating_star,
        historical_sold: product.historical_sold
      });

      return product;
    } catch (error) {
      appendDebugLog('content', 'Content fetch exception, thử page-context fallback nếu có thể', {
        shopId,
        itemId,
        error: error.message || String(error)
      });

      if (/page-context fallback/i.test(error.message || '')) {
        throw error;
      }

      return fetchCurrentProductByPageContext(shopId, itemId, error.message || String(error));
    }
  }

  async function syncCurrentProduct(force = false) {
    const url = window.location.href;
    const ids = parseShopeeProductIds(url);

    appendDebugLog('content', 'Sync current product', { force, url, ids });

    if (!ids) {
      lastFetchedKey = '';
      await clearCurrentProduct('Trang hiện tại không phải trang sản phẩm Shopee hoặc URL không có dạng -i.shopId.itemId.');
      return {
        ok: false,
        reason: 'NOT_PRODUCT_PAGE',
        error: 'Không tìm thấy shopId/itemId trong URL.',
        url
      };
    }

    const productKey = ids.productKey;

    if (!force && productKey === lastFetchedKey) {
      const stored = await chrome.storage.local.get(STORAGE_PRODUCT_KEY);
      appendDebugLog('content', 'Dùng cache currentProduct', { productKey, hasStored: Boolean(stored[STORAGE_PRODUCT_KEY]) });
      return {
        ok: true,
        product: stored[STORAGE_PRODUCT_KEY] || null,
        cached: true
      };
    }

    if (isFetching) {
      appendDebugLog('content', 'Đang fetch nên bỏ qua lần sync này', { productKey });
      return {
        ok: false,
        reason: 'FETCHING',
        error: 'Content script đang đọc sản phẩm, thử lại sau vài giây.'
      };
    }

    isFetching = true;

    try {
      const product = await fetchCurrentProduct(ids.shopId, ids.itemId);

      await chrome.storage.local.set({
        [STORAGE_PRODUCT_KEY]: product,
        [STORAGE_STATUS_KEY]: {
          isProductPage: true,
          productKey: product.productKey,
          itemid: product.itemid,
          shopid: product.shopid,
          name: product.name,
          updatedAt: Date.now(),
          url: window.location.href
        }
      });

      appendDebugLog('content', 'Đã lưu currentProduct vào storage', {
        productKey: product.productKey,
        name: product.name
      });

      lastFetchedKey = productKey;

      return {
        ok: true,
        product
      };
    } catch (error) {
      const stored = await chrome.storage.local.get(STORAGE_PRODUCT_KEY);
      const storedProduct = stored && stored[STORAGE_PRODUCT_KEY];

      if (storedProduct && storedProduct.productKey === productKey) {
        await saveStatus({
          isProductPage: true,
          productKey,
          itemid: ids.itemId,
          shopid: ids.shopId,
          warning: `Content script đọc API lỗi nhưng vẫn giữ sản phẩm đã lưu: ${error.message || String(error)}`
        });

        appendDebugLog('content', 'Sync thất bại nhưng giữ currentProduct đã có', {
          productKey,
          storedName: storedProduct.name,
          error: error.message || String(error)
        });

        lastFetchedKey = productKey;

        return {
          ok: true,
          product: storedProduct,
          cached: true,
          warning: error.message || String(error)
        };
      }

      await chrome.storage.local.remove(STORAGE_PRODUCT_KEY);
      await saveStatus({
        isProductPage: true,
        productKey,
        itemid: ids.itemId,
        shopid: ids.shopId,
        error: error.message || 'Không đọc được sản phẩm hiện tại.'
      });

      appendDebugLog('content', 'Sync current product thất bại', {
        productKey,
        error: error.message || String(error),
        stack: error.stack || ''
      });

      return {
        ok: false,
        reason: 'API_ERROR',
        error: error.message || String(error)
      };
    } finally {
      isFetching = false;
    }
  }

  function handleUrlChange() {
    const currentUrl = window.location.href;

    if (currentUrl === lastHandledUrl) {
      return;
    }

    appendDebugLog('content', 'URL thay đổi', {
      from: lastHandledUrl,
      to: currentUrl
    });

    lastHandledUrl = currentUrl;
    syncCurrentProduct(false).catch((error) => {
      appendDebugLog('content', 'handleUrlChange sync error', { error: error.message || String(error) });
    });
  }

  function patchHistoryMethod(methodName) {
    const originalMethod = history[methodName];

    if (typeof originalMethod !== 'function') {
      return;
    }

    history[methodName] = function patchedHistoryMethod(...args) {
      const result = originalMethod.apply(this, args);
      setTimeout(handleUrlChange, 350);
      setTimeout(handleUrlChange, 1200);
      return result;
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'GET_CURRENT_PRODUCT') {
      return false;
    }

    appendDebugLog('content', 'Nhận message GET_CURRENT_PRODUCT', { message });

    syncCurrentProduct(true)
      .then((result) => {
        appendDebugLog('content', 'Trả response GET_CURRENT_PRODUCT', result);
        sendResponse(result);
      })
      .catch((error) => {
        appendDebugLog('content', 'GET_CURRENT_PRODUCT lỗi ngoài dự kiến', {
          error: error.message || String(error),
          stack: error.stack || ''
        });
        sendResponse({
          ok: false,
          reason: 'UNEXPECTED_ERROR',
          error: error.message || String(error)
        });
      });

    return true;
  });

  patchHistoryMethod('pushState');
  patchHistoryMethod('replaceState');
  window.addEventListener('popstate', () => setTimeout(handleUrlChange, 350));
  window.addEventListener('hashchange', () => setTimeout(handleUrlChange, 350));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      setTimeout(handleUrlChange, 350);
    }
  });

  appendDebugLog('content', 'Content script loaded v1.0.3-passive', {
    href: window.location.href,
    readyState: document.readyState
  });

  setTimeout(handleUrlChange, 500);
  setTimeout(handleUrlChange, 1800);
})();
