// passive-capture.js v1.0.3 - Shopee Price Finder
// Lắng nghe dữ liệu Shopee mà chính trang Shopee đã tải sẵn.
// Không tự gọi API mới ở file này, chỉ hook fetch/XMLHttpRequest để cache item vào window.__SPF_PASSIVE_STORE__.
(function () {
  'use strict';

  if (window.__SPF_PASSIVE_CAPTURE_INSTALLED__) return;
  window.__SPF_PASSIVE_CAPTURE_INSTALLED__ = true;

  const MAX_ITEMS = 1000;
  const MAX_EVENTS = 160;
  const API_PATTERNS = [
    '/api/v4/item/get',
    '/api/v4/pdp/get_pc',
    '/api/v4/search/search_items',
    '/api/v4/recommend/product_detail_page',
    '/api/v4/recommend/recommend_post',
    '/api/v4/recommend/recommend',
    '/api/v4/pdp/hot_sales',
    '/api/v4/shop/rcmd_items',
    '/api/v4/shop/get_shop_tab',
    '/api/v4/collection/get_items',
    '/api/v4/search/search_hint',
    '/api/v4/search/search_suggestion',
    '/api/v4/search/search_user',
    '/api/v4/shop/get_shop_base'
  ];

  const store = window.__SPF_PASSIVE_STORE__ = window.__SPF_PASSIVE_STORE__ || {
    installedAt: Date.now(),
    updatedAt: 0,
    items: {},
    events: []
  };

  // Tương thích với phần mềm Price Fix mà bạn gửi.
  window.__SPO_PASSIVE_STORE__ = window.__SPO_PASSIVE_STORE__ || store;

  function isShopeeApi(url) {
    const text = String(url || '');
    return API_PATTERNS.some((pattern) => text.includes(pattern));
  }

  function getSourceType(url) {
    const text = String(url || '');
    if (text.includes('/item/get')) return 'item';
    if (text.includes('/pdp/')) return 'pdp';
    if (text.includes('/search/search_items')) return 'search';
    if (text.includes('/recommend/')) return 'recommend';
    if (text.includes('/shop/')) return 'shop';
    if (text.includes('/collection/')) return 'collection';
    return 'api';
  }

  function getItemKey(item) {
    return String(item && (item.shopid || item.shop_id || item.shopId || '')) + '.' + String(item && (item.itemid || item.item_id || item.itemId || ''));
  }

  function isItemObject(value) {
    return Boolean(value && typeof value === 'object' &&
      (value.itemid || value.item_id || value.itemId) &&
      (value.shopid || value.shop_id || value.shopId));
  }

  function stripItem(value, url, sourceType) {
    if (!value || typeof value !== 'object') return null;

    const item = value.item_basic || value.basic || value.item || value;
    if (!isItemObject(item)) return null;

    const itemid = item.itemid || item.item_id || item.itemId;
    const shopid = item.shopid || item.shop_id || item.shopId;
    const ratingStar = item.item_rating?.rating_star ?? item.rating_star ?? item.rating ?? 0;
    const ratingCount = item.item_rating?.rating_count || item.rating_count || [];
    const images = item.images || (item.image ? [item.image] : []);
    const salePrice = item.price || item.current_price || item.sale_price || item.price_info?.price || 0;
    const salePriceMin = item.price_min || item.priceMin || item.current_price_min || item.sale_price_min || item.price_info?.price_min || salePrice || 0;
    const salePriceMax = item.price_max || item.priceMax || item.current_price_max || item.sale_price_max || item.price_info?.price_max || salePrice || 0;

    return {
      itemid,
      shopid,
      name: item.name || item.title || '',
      price: salePrice,
      price_min: salePriceMin,
      price_max: salePriceMax,
      price_before_discount: item.price_before_discount || item.priceBeforeDiscount || 0,
      discount: item.discount || '',
      sold: item.sold || item.sold_count || 0,
      historical_sold: item.historical_sold || item.historicalSold || 0,
      catid: item.catid || item.cat_id || item.category_id || 0,
      item_rating: item.item_rating || (ratingStar ? { rating_star: ratingStar, rating_count: ratingCount } : undefined),
      rating_star: ratingStar,
      rating_count: ratingCount,
      image: item.image || images[0] || '',
      images,
      shop_name: item.shop_name || item.shopname || item.shop?.name || '',
      shop_location: item.shop_location || item.item_location || item.location || '',
      source_url: String(url || '').slice(0, 260),
      sourceType: sourceType || getSourceType(url),
      capturedAt: Date.now()
    };
  }

  function addItem(value, url, sourceType) {
    const item = stripItem(value, url, sourceType);
    if (!item) return false;

    const key = getItemKey(item);
    if (!key || key === '.') return false;

    const old = store.items[key] || {};
    store.items[key] = Object.assign({}, old, item, {
      sourceType: item.sourceType || old.sourceType || sourceType || 'passive',
      capturedAt: Date.now()
    });
    return true;
  }

  function pruneStore() {
    const keys = Object.keys(store.items || {});
    if (keys.length <= MAX_ITEMS) return;

    keys
      .sort((a, b) => (store.items[a]?.capturedAt || 0) - (store.items[b]?.capturedAt || 0))
      .slice(0, keys.length - MAX_ITEMS)
      .forEach((key) => delete store.items[key]);
  }

  function walk(value, url, sourceType, depth, counter) {
    if (!value || typeof value !== 'object' || depth > 8 || counter.count > 320) return;

    if (isItemObject(value) || (value.item_basic && isItemObject(value.item_basic))) {
      if (addItem(value, url, sourceType)) counter.count += 1;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length && i < 220; i += 1) {
        walk(value[i], url, sourceType, depth + 1, counter);
      }
      return;
    }

    const keys = Object.keys(value);
    for (let i = 0; i < keys.length && i < 100; i += 1) {
      const child = value[keys[i]];
      if (child && typeof child === 'object') {
        walk(child, url, sourceType, depth + 1, counter);
      }
    }
  }

  function captureJson(url, json) {
    try {
      if (!isShopeeApi(url)) return;

      const sourceType = getSourceType(url);
      const counter = { count: 0 };
      walk(json, String(url || ''), sourceType, 0, counter);

      store.updatedAt = Date.now();
      store.events.push({
        t: Date.now(),
        url: String(url || '').slice(0, 220),
        sourceType,
        count: counter.count,
        total: Object.keys(store.items || {}).length
      });

      if (store.events.length > MAX_EVENTS) {
        store.events.splice(0, store.events.length - MAX_EVENTS);
      }

      pruneStore();

      if (counter.count > 0) {
        window.dispatchEvent(new CustomEvent('__SPF_PASSIVE_CAPTURE__', {
          detail: { sourceType, count: counter.count, total: Object.keys(store.items || {}).length }
        }));
      }
    } catch (error) {
      console.warn('[SPF Passive] captureJson error', error);
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function patchedFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const promise = originalFetch.apply(this, arguments);

      if (isShopeeApi(url)) {
        promise.then((response) => {
          try {
            const contentType = response.headers && response.headers.get && response.headers.get('content-type');
            if (contentType && !String(contentType).includes('json')) return;
            response.clone().json().then((json) => captureJson(response.url || url, json)).catch(() => {});
          } catch (_) {}
        }).catch(() => {});
      }

      return promise;
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR && OriginalXHR.prototype) {
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function patchedOpen(method, url) {
      this.__spfPassiveUrl = url;
      return originalOpen.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function patchedSend() {
      try {
        this.addEventListener('load', function onLoad() {
          const url = this.__spfPassiveUrl || this.responseURL || '';
          if (!isShopeeApi(url)) return;

          const contentType = this.getResponseHeader && this.getResponseHeader('content-type');
          if (contentType && !String(contentType).includes('json')) return;

          try {
            const json = JSON.parse(this.responseText || '{}');
            captureJson(this.responseURL || url, json);
          } catch (_) {}
        });
      } catch (_) {}

      return originalSend.apply(this, arguments);
    };
  }

  console.log('[SPF Passive] installed', { at: new Date().toISOString() });
})();
