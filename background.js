'use strict';

const SHOPEE_SEARCH_API = 'https://shopee.vn/api/v4/search/search_items';
const SEARCH_API_LIMIT = 80;
const RETURN_RESULT_LIMIT = 50;
const MAX_KEYWORD_VARIANTS = 6;
const SEARCH_DELAY_MS = 420;
const SHOPEE_ITEM_API = 'https://shopee.vn/api/v4/item/get';
const PRICE_DIVISOR = 100000;
const STORAGE_PRODUCT_KEY = 'currentProduct';
const STORAGE_STATUS_KEY = 'currentProductStatus';
const STORAGE_DEBUG_KEY = 'debugLogs';
const MAX_DEBUG_LOGS = 220;
const STOPWORDS = new Set(['cho', 'voi', 'danh', 'va', 'cua', 'cac', 'co', 'khong', 'duoc', 'tu']);
const IMPORTANT_WORDS = new Set([
  'op', 'ốp', 'case', 'kinh', 'kính', 'cuong', 'cường', 'luc', 'lực', 'dan', 'dán',
  'sac', 'sạc', 'cap', 'cáp', 'pin', 'du', 'dự', 'phong', 'phòng', 'nhanh',
  'magnetic', 'nam', 'cham', 'châm', 'hit', 'hít', 'tinh', 'tính', 'vien', 'viền',
  'trong', 'suot', 'suốt', 'nham', 'nhám', 'mo', 'mờ', 'chong', 'chống', 'truot',
  'trượt', 'phan', 'phản', 'quang', 'guong', 'gương', 'camera', 'iphone', 'ipad',
  'samsung', 'xiaomi', 'huawei', 'type', 'usb', 'pd', 'gan', 'magsafe', 'watch',
  'awatch', 'airpods', 'pro', 'max', 'plus', 'mini'
]);

const EXCLUDED_SHOP_KEYWORDS = ['njoyvn', 'njoyshop', 'cloverb', 'popkon'];
const HCM_LOCATION_KEYWORDS = ['ho chi minh', 'hcm', 'tphcm', 'tp hcm', 'tp ho chi minh', 'sai gon', 'saigon', 'thanh pho ho chi minh'];
const HCM_BASE_SHOP_KEYWORDS = ['njoyvn', 'njoyshop', 'njoy'];
const SHOPEE_PRODUCT_URL_RE = /(?:^|[\/-])i\.\d{4,}\.\d{6,}(?=$|[/?#&])|\/product\/\d{4,}\/\d{6,}(?=$|[/?#&])/;

function isShopeeProductPageUrl(url = '') {
  try {
    const parsed = new URL(String(url || ''));
    const isShopee = parsed.hostname === 'shopee.vn' || parsed.hostname.endsWith('.shopee.vn');
    return isShopee && SHOPEE_PRODUCT_URL_RE.test(parsed.href);
  } catch (error) {
    return false;
  }
}


function normalizeShopText(value) {
  return stripVietnamese(value)
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function normalizeLooseText(value) {
  return stripVietnamese(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isHcmText(value) {
  const text = normalizeLooseText(value);
  if (!text) {
    return false;
  }

  return HCM_LOCATION_KEYWORDS.some((keyword) => text.includes(normalizeLooseText(keyword)));
}

function getShopTextForLocation(product) {
  return [
    product && product.shop_location,
    product && product.item_location,
    product && product.location,
    product && product.shop_name,
    product && product.shopname,
    product && product.shop,
    product && product.seller_name,
    product && product.username
  ].filter(Boolean).join(' ');
}

function isNjoyBaseShop(product) {
  const shopText = normalizeShopText([
    product && product.shop_name,
    product && product.shopname,
    product && product.shop,
    product && product.seller_name,
    product && product.username
  ].filter(Boolean).join(' '));

  if (HCM_BASE_SHOP_KEYWORDS.some((keyword) => shopText.includes(normalizeShopText(keyword)))) {
    return true;
  }

  // Shop Njoy chính đang dùng trong log/test của bạn.
  return Number(product && (product.shopid || product.shop_id || product.shopId) || 0) === 16838536;
}

function isBaseShopHcm(product) {
  return isHcmText(getShopTextForLocation(product)) || isNjoyBaseShop(product);
}

function isCandidateShopHcm(product) {
  return isHcmText(getShopTextForLocation(product));
}

function getPriceGapInfo(baseProduct, candidateProduct) {
  const basePrice = getComparablePrice(baseProduct);
  const candidatePrice = getComparablePrice(candidateProduct);

  if (!(basePrice > 0) || !(candidatePrice > 0)) {
    return {
      ok: true,
      basePrice,
      candidatePrice,
      diffRatio: null,
      diffPercent: null,
      reason: ''
    };
  }

  const diffRatio = Math.abs(candidatePrice - basePrice) / basePrice;
  return {
    ok: diffRatio <= 0.5,
    basePrice,
    candidatePrice,
    diffRatio,
    diffPercent: Number((diffRatio * 100).toFixed(2)),
    reason: diffRatio > 0.5 ? `price-gap-over-50:${Number((diffRatio * 100).toFixed(2))}%` : ''
  };
}

function getExcludedShopReason(product, baseProduct) {
  if (!product) {
    return '';
  }

  const productShopId = Number(product.shopid || product.shop_id || product.shopId || 0);
  const baseShopId = Number(baseProduct && (baseProduct.shopid || baseProduct.shop_id || baseProduct.shopId) || 0);

  // Khi đang xem sản phẩm shop mình, bỏ toàn bộ item cùng shopid để tránh so giá ngược với chính mình.
  if (baseShopId && productShopId && productShopId === baseShopId) {
    return `same-shopid:${productShopId}`;
  }

  const shopText = normalizeShopText([
    product.shop_name,
    product.shopname,
    product.shop,
    product.seller_name,
    product.username
  ].filter(Boolean).join(' '));

  if (!shopText) {
    return '';
  }

  const matchedKeyword = EXCLUDED_SHOP_KEYWORDS.find((keyword) => shopText.includes(normalizeShopText(keyword)));
  return matchedKeyword ? `excluded-shop:${matchedKeyword}` : '';
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return String(value);
  }
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
    console.warn('[SPF:background] Không lưu được debug log:', error);
  }
}


async function updateSidePanelAvailability(tabId, url) {
  if (!chrome.sidePanel || !chrome.sidePanel.setOptions || !tabId) {
    return;
  }

  const enabled = isShopeeProductPageUrl(url);

  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: 'popup.html',
      enabled
    });

    appendDebugLog('background', 'Cập nhật trạng thái side panel theo tab', { tabId, enabled, url });
  } catch (error) {
    appendDebugLog('background', 'Không cập nhật được side panel theo tab', { tabId, error: error.message || String(error) });
  }
}

function enableSidePanelActionOpen() {
  try {
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      // Để Chrome tự mở side panel ngay khi bấm icon.
      // Bản trước gọi sidePanel.open sau async setOptions nên đôi lúc Chrome chặn user gesture và panel không hiện.
      chrome.sidePanel.setOptions({ path: 'popup.html', enabled: false }).catch(() => {});
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
  } catch (error) {
    appendDebugLog('background', 'Không đổi được side panel behavior', { error: error.message || String(error) });
  }
}

try {
  if (chrome.runtime && chrome.runtime.onInstalled) {
    chrome.runtime.onInstalled.addListener(enableSidePanelActionOpen);
  }
  if (chrome.runtime && chrome.runtime.onStartup) {
    chrome.runtime.onStartup.addListener(enableSidePanelActionOpen);
  }
  enableSidePanelActionOpen();
} catch (error) {
  console.warn('[SPF:background] sidePanel init warning:', error);
}

try {
  // Side panel được mở tự động bằng openPanelOnActionClick.
  // Extension chỉ bật panel ở trang sản phẩm Shopee, tắt ở trang khác.
  if (chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if ((changeInfo.status === 'loading' || changeInfo.status === 'complete') && tab && tab.url) {
        updateSidePanelAvailability(tabId, tab.url);
      }
    });
  }

  if (chrome.tabs && chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        await updateSidePanelAvailability(activeInfo.tabId, tab && tab.url);
      } catch (error) {
        appendDebugLog('background', 'Không đọc được tab active để cập nhật side panel', { error: error.message || String(error) });
      }
    });
  }

  if (chrome.tabs && chrome.tabs.query) {
    chrome.tabs.query({}, (tabs) => {
      (tabs || []).forEach((tab) => {
        if (tab && tab.id && tab.url) updateSidePanelAvailability(tab.id, tab.url);
      });
    });
  }
} catch (error) {
  console.warn('[SPF:background] sidePanel availability warning:', error);
}

function stripVietnamese(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeToken(value) {
  return stripVietnamese(value)
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function splitWords(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/[()\[\]{}|,.;:!?"“”'’`~_+=\\/<>-]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

function scoreKeywordToken(raw, normalized, index) {
  let score = 0;

  if (IMPORTANT_WORDS.has(raw) || IMPORTANT_WORDS.has(normalized)) {
    score += 8;
  }

  if (/\d/.test(normalized)) {
    score += 5;
  }

  if (normalized.length >= 6) {
    score += 5;
  } else if (normalized.length >= 4) {
    score += 3;
  } else {
    score += 1;
  }

  score += Math.max(0, 6 - index * 0.25);

  return score;
}

function getKeywordTokens(name) {
  const words = splitWords(name);
  const seen = new Set();
  const tokens = [];

  words.forEach((raw, index) => {
    const normalized = normalizeToken(raw);

    if (!normalized || normalized.length < 2) {
      return;
    }

    if (STOPWORDS.has(normalized) || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    tokens.push({
      raw,
      normalized,
      index,
      score: scoreKeywordToken(raw, normalized, index)
    });
  });

  appendDebugLog('background', 'Tách token keyword', {
    name,
    tokens
  });

  return tokens;
}

function detectDeviceKeyword(tokens, looseName) {
  const text = looseName || '';
  const hasToken = (value) => tokens.some((token) => token.normalized === value || token.raw.toLowerCase() === value);

  if (text.includes('iphone') || hasToken('iphone')) return 'iphone';
  if (text.includes('samsung')) return 'samsung';
  if (text.includes('xiaomi')) return 'xiaomi';
  if (text.includes('ipad')) return 'ipad';
  if (text.includes('airpods') || text.includes('airpod')) return 'airpods';
  if (text.includes('awatch') || text.includes('apple watch') || text.includes('watch')) return 'awatch';
  return '';
}

function hasLooseAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function buildGroupKeywordVariants(name, tokens) {
  const looseName = normalizeLooseText(name);
  const device = detectDeviceKeyword(tokens, looseName);
  const groupKeywords = [];
  const add = (value) => {
    const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
    if (cleaned && !groupKeywords.includes(cleaned)) groupKeywords.push(cleaned);
  };

  if (hasLooseAny(looseName, ['op ', 'op lung', 'case'])) {
    add(['ốp nhám', device].filter(Boolean).join(' '));
    add(['ốp lưng nhám', device].filter(Boolean).join(' '));
    if (hasLooseAny(looseName, ['sac khong day', 'magnetic', 'magsafe', 'tu tinh', 'nam cham'])) {
      add(['ốp sạc không dây', device].filter(Boolean).join(' '));
      add(['ốp từ tính', device].filter(Boolean).join(' '));
    }
    if (hasLooseAny(looseName, ['sieu mong', 'slim', 'mong'])) add(['ốp slim', device].filter(Boolean).join(' '));
    if (hasLooseAny(looseName, ['trong mo', 'nham mo', 'chong van tay'])) add(['ốp chống vân tay', device].filter(Boolean).join(' '));
    return groupKeywords;
  }

  if (hasLooseAny(looseName, ['kinh', 'cuong luc', 'dan man', 'mieng dan'])) {
    add(['kính cường lực', device].filter(Boolean).join(' '));
    add(['kính full màn', device].filter(Boolean).join(' '));
    if (hasLooseAny(looseName, ['chong nhin trom', 'privacy'])) add(['kính chống nhìn trộm', device].filter(Boolean).join(' '));
    if (hasLooseAny(looseName, ['nham', 'chong van tay'])) add(['kính nhám', device].filter(Boolean).join(' '));
    return groupKeywords;
  }

  if (hasLooseAny(looseName, ['cap ', 'cable', 'type c', 'usb c', 'lightning', 'iightnig'])) {
    const wattMatch = String(name || '').match(/(20|22\.5|27|30|45|60|65|100|120|140|240)\s*w/i);
    const watt = wattMatch ? wattMatch[1] + 'W' : '';
    add(['cáp sạc nhanh', watt].filter(Boolean).join(' '));
    add(['cáp type c', device].filter(Boolean).join(' '));
    if (watt) add(['cáp', watt, 'type c'].join(' '));
    return groupKeywords;
  }

  if (hasLooseAny(looseName, ['sac ', 'cu sac', 'củ sạc', 'gan', 'charger'])) {
    const wattMatch = String(name || '').match(/(20|22\.5|27|30|35|45|60|65|67|100|120|140|240)\s*w/i);
    const watt = wattMatch ? wattMatch[1] + 'W' : '';
    add(['củ sạc nhanh', watt].filter(Boolean).join(' '));
    add(['sạc nhanh', watt].filter(Boolean).join(' '));
    if (hasLooseAny(looseName, ['gan'])) add(['sạc gan', watt].filter(Boolean).join(' '));
    return groupKeywords;
  }

  return groupKeywords;
}

function buildKeywordVariants(name) {
  const tokens = getKeywordTokens(name);

  if (!tokens.length) {
    appendDebugLog('background', 'Không tạo được keyword vì không có token', { name });
    return [];
  }

  const sortedByImportance = [...tokens].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return a.index - b.index;
  });

  const buildKeyword = (count) => sortedByImportance
    .slice(0, count)
    .sort((a, b) => a.index - b.index)
    .map((token) => token.raw)
    .join(' ')
    .trim();

  const primary = buildKeyword(5);
  const secondary = buildKeyword(3);
  const fallback = tokens.slice(0, 4).map((token) => token.raw).join(' ').trim();
  const groupKeywords = buildGroupKeywordVariants(name, tokens);

  const keywords = [...new Set([primary, secondary, fallback, ...groupKeywords].filter(Boolean))]
    .filter((keyword) => keyword.split(/\s+/).filter(Boolean).length >= 2)
    .slice(0, MAX_KEYWORD_VARIANTS);

  appendDebugLog('background', 'Keyword variants mở rộng', {
    name,
    keywords,
    sortedByImportance,
    groupKeywords
  });

  return keywords;
}

function tokenizeForSimilarity(value) {
  const normalized = stripVietnamese(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return [];
  }

  const seen = new Set();

  return normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !STOPWORDS.has(token))
    .filter((token) => {
      if (seen.has(token)) {
        return false;
      }
      seen.add(token);
      return true;
    });
}

function jaccardSimilarity(textA, textB) {
  const setA = new Set(tokenizeForSimilarity(textA));
  const setB = new Set(tokenizeForSimilarity(textB));

  if (!setA.size || !setB.size) {
    return 0;
  }

  let intersection = 0;
  setA.forEach((token) => {
    if (setB.has(token)) {
      intersection += 1;
    }
  });

  const union = new Set([...setA, ...setB]).size;
  return union ? intersection / union : 0;
}

function toVnd(rawPrice) {
  const value = Number(rawPrice || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  // API Shopee thường trả VND * 100000. Dữ liệu DOM/passive có thể đã là VND thật.
  return Math.round(value > 1000000 ? value / PRICE_DIVISOR : value);
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

function slugifyProductName(name) {
  const slug = stripVietnamese(name)
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return slug || 'san-pham';
}

function buildProductUrl(product) {
  const slug = slugifyProductName(product.name);
  return `https://shopee.vn/${slug}-i.${product.shopid}.${product.itemid}`;
}

function normalizeCurrentItem(rawItem, sourceUrl) {
  const itemId = rawItem.itemid || rawItem.item_id || rawItem.itemId || 0;
  const shopId = rawItem.shopid || rawItem.shop_id || rawItem.shopId || 0;
  const images = Array.isArray(rawItem.images) ? rawItem.images : (rawItem.image ? [rawItem.image] : []);
  const firstImage = images[0] || rawItem.image || '';
  const rating = rawItem.item_rating || (rawItem.rating_star ? { rating_star: rawItem.rating_star, rating_count: rawItem.rating_count || [] } : {});
  const sold = Number(rawItem.historical_sold || rawItem.historicalSold || rawItem.sold || rawItem.sold_count || 0);

  return {
    itemid: Number(itemId || 0),
    shopid: Number(shopId || 0),
    name: String(rawItem.name || rawItem.title || '').trim(),
    price: toVnd(rawItem.price || rawItem.price_min || rawItem.priceMin || rawItem.current_price || rawItem.sale_price),
    price_min: toVnd(rawItem.price_min || rawItem.priceMin || rawItem.current_price_min || rawItem.sale_price_min || rawItem.price),
    price_max: toVnd(rawItem.price_max || rawItem.priceMax || rawItem.current_price_max || rawItem.sale_price_max || rawItem.price),
    discount: rawItem.discount || '',
    historical_sold: sold,
    catid: Number(rawItem.catid || rawItem.cat_id || rawItem.category_id || 0),
    image: firstImage || '',
    image_url: buildImageUrl(firstImage),
    images,
    rating_star: Number(rating.rating_star || rawItem.rating_star || rawItem.rating || 0),
    rating_count: getRatingCount(rating),
    description: String(rawItem.description || ''),
    sourceUrl,
    source: rawItem.source || rawItem.sourceType || 'api',
    productKey: `${shopId}_${itemId}`,
    fetchedAt: Date.now()
  };
}

function normalizeSearchItem(rawItem) {
  const item = rawItem && rawItem.item_basic ? rawItem.item_basic : rawItem;

  if (!item) {
    return null;
  }

  const itemId = item.itemid || item.item_id || item.itemId || 0;
  const shopId = item.shopid || item.shop_id || item.shopId || 0;
  const rating = item.item_rating || (item.rating_star ? { rating_star: item.rating_star, rating_count: item.rating_count || [] } : {});
  const image = item.image || (Array.isArray(item.images) ? item.images[0] : '');

  const product = {
    itemid: Number(itemId || 0),
    shopid: Number(shopId || 0),
    name: String(item.name || item.title || '').trim(),
    price: toVnd(item.price || item.price_min || item.priceMin || item.current_price || item.sale_price),
    price_min: toVnd(item.price_min || item.priceMin || item.current_price_min || item.sale_price_min || item.price),
    price_max: toVnd(item.price_max || item.priceMax || item.current_price_max || item.sale_price_max || item.price),
    discount: item.discount || '',
    historical_sold: Number(item.historical_sold || item.historicalSold || item.sold || item.sold_count || 0),
    catid: Number(item.catid || item.cat_id || item.category_id || 0),
    image: image || '',
    image_url: buildImageUrl(image),
    shop_name: item.shop_name || item.shopname || (item.shop && item.shop.name) || '',
    shop_location: item.shop_location || item.item_location || item.location || '',
    rating_star: Number(rating.rating_star || item.rating_star || item.rating || 0),
    rating_count: getRatingCount(rating),
    source: item.source || item.sourceType || ''
  };

  product.url = buildProductUrl(product);

  if (!product.itemid || !product.shopid || !product.name) {
    return null;
  }

  return product;
}

function getComparablePrice(product) {
  return Number(product.price_min || product.price || product.price_max || 0);
}

function calculateSalesScore(sold) {
  const n = Math.max(0, Number(sold || 0));

  // Lượt bán là tín hiệu cạnh tranh rất quan trọng.
  // Dùng thang bậc để sản phẩm chỉ bán vài đơn không thể leo top chỉ nhờ rating/tên tốt.
  if (n >= 10000) return 25;
  if (n >= 5000) return 23;
  if (n >= 2000) return 21;
  if (n >= 1000) return 18;
  if (n >= 500) return 15;
  if (n >= 300) return 12;
  if (n >= 100) return 9;
  if (n >= 50) return 6;
  if (n >= 20) return 3;
  if (n >= 5) return 1;
  return 0;
}

function applySalesConfidenceCap(score, sold) {
  const n = Math.max(0, Number(sold || 0));

  // Cap tổng điểm theo độ tin cậy lượt bán.
  // Ví dụ: sản phẩm chỉ bán 2 đơn không nên đứng top dù cùng ngành, rating cao, giá gần.
  if (n < 5) return Math.min(score, 50);
  if (n < 20) return Math.min(score, 58);
  if (n < 50) return Math.min(score, 65);
  if (n < 100) return Math.min(score, 72);
  if (n < 300) return Math.min(score, 80);
  if (n < 1000) return Math.min(score, 88);
  return score;
}

function calculateSimilarityScore(baseProduct, candidateProduct) {
  const nameSimilarity = jaccardSimilarity(baseProduct.name, candidateProduct.name);
  const nameScore = nameSimilarity * 35;
  const catScore = Number(baseProduct.catid) && Number(candidateProduct.catid) && Number(baseProduct.catid) === Number(candidateProduct.catid) ? 15 : 0;
  const ratingScore = Math.min(Number(candidateProduct.rating_star || 0) / 5, 1) * 10;
  const soldRaw = Number(candidateProduct.historical_sold || 0);
  const soldScore = calculateSalesScore(soldRaw);

  const priceGap = getPriceGapInfo(baseProduct, candidateProduct);
  let priceScore = 0;

  if (priceGap.basePrice > 0 && priceGap.candidatePrice > 0) {
    priceScore = priceGap.diffRatio <= 0.25 ? 10 : 7;
  }

  const baseIsHcm = isBaseShopHcm(baseProduct);
  const candidateIsHcm = isCandidateShopHcm(candidateProduct);
  const locationScore = baseIsHcm && candidateIsHcm ? 5 : 0;

  const rawTotalScore = nameScore + catScore + ratingScore + soldScore + priceScore + locationScore;
  const cappedTotalScore = applySalesConfidenceCap(rawTotalScore, soldRaw);
  const salesCapApplied = cappedTotalScore < rawTotalScore;

  return {
    score: Math.round(cappedTotalScore),
    scoreDetail: {
      nameSimilarity: Number(nameSimilarity.toFixed(4)),
      nameScore: Number(nameScore.toFixed(2)),
      catScore,
      ratingScore: Number(ratingScore.toFixed(2)),
      soldScore: Number(soldScore.toFixed(2)),
      soldRaw,
      priceScore,
      locationScore,
      rawTotalScore: Number(rawTotalScore.toFixed(2)),
      salesCapApplied,
      salesCapScore: Number(cappedTotalScore.toFixed(2)),
      baseIsHcm,
      candidateIsHcm,
      basePrice: priceGap.basePrice,
      candidatePrice: priceGap.candidatePrice,
      priceDiffPercent: priceGap.diffPercent
    }
  };
}

function executeScriptInMainWorld(tabId, request) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      world: 'MAIN',
      func: async (fetchRequest) => {
        const startedAt = Date.now();

        try {
          const response = await fetch(fetchRequest.url, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            headers: fetchRequest.headers || {}
          });

          const text = await response.text();
          let json = null;
          let parseError = '';

          try {
            json = text ? JSON.parse(text) : null;
          } catch (error) {
            parseError = error && error.message ? error.message : String(error);
          }

          return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            contentType: response.headers.get('content-type') || '',
            elapsedMs: Date.now() - startedAt,
            bodyPreview: text.slice(0, 1000),
            parseError,
            json
          };
        } catch (error) {
          return {
            ok: false,
            status: 0,
            statusText: '',
            contentType: '',
            elapsedMs: Date.now() - startedAt,
            bodyPreview: '',
            parseError: '',
            error: error && error.message ? error.message : String(error),
            json: null
          };
        }
      },
      args: [request]
    }, (results) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      const result = results && results[0] ? results[0].result : null;
      if (!result) {
        reject(new Error('Không nhận được kết quả từ page context.'));
        return;
      }

      resolve(result);
    });
  });
}


function executeMainWorldFunction(tabId, func, args = []) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      world: 'MAIN',
      func,
      args
    }, (results) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(results && results[0] ? results[0].result : null);
    });
  });
}

async function readPassiveSnapshot(tabId, shopId, itemId) {
  if (!tabId) {
    return { installed: false, count: 0, item: null, items: [], events: [] };
  }

  try {
    const snapshot = await executeMainWorldFunction(tabId, (targetShopId, targetItemId) => {
      const store = window.__SPF_PASSIVE_STORE__ || window.__SPO_PASSIVE_STORE__ || null;
      if (!store) {
        return { installed: false, count: 0, item: null, items: [], events: [] };
      }

      const itemsObj = store.items || {};
      const key = String(targetShopId || '') + '.' + String(targetItemId || '');
      const items = Object.values(itemsObj)
        .filter(Boolean)
        .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0))
        .slice(0, 500);

      return {
        installed: true,
        updatedAt: store.updatedAt || 0,
        count: Object.keys(itemsObj).length,
        item: itemsObj[key] || null,
        items,
        events: (store.events || []).slice(-20)
      };
    }, [shopId || '', itemId || '']);

    appendDebugLog('background', 'Passive snapshot', {
      tabId,
      installed: snapshot && snapshot.installed,
      count: snapshot && snapshot.count,
      hasTargetItem: Boolean(snapshot && snapshot.item),
      events: snapshot && snapshot.events
    });

    return snapshot || { installed: false, count: 0, item: null, items: [], events: [] };
  } catch (error) {
    appendDebugLog('background', 'Đọc passive snapshot lỗi', { tabId, error: error.message || String(error) });
    return { installed: false, count: 0, item: null, items: [], events: [] };
  }
}

async function getCurrentProductFromPassive(tabId, shopId, itemId, sourceUrl) {
  const snapshot = await readPassiveSnapshot(tabId, shopId, itemId);
  if (!snapshot || !snapshot.item) {
    return null;
  }

  const product = normalizeCurrentItem({ ...snapshot.item, source: 'passive-capture' }, sourceUrl || '');
  if (!product.itemid || !product.shopid || !product.name) {
    return null;
  }

  await setStorage({
    [STORAGE_PRODUCT_KEY]: product,
    [STORAGE_STATUS_KEY]: {
      isProductPage: true,
      productKey: product.productKey,
      itemid: product.itemid,
      shopid: product.shopid,
      name: product.name,
      source: 'passive-capture',
      updatedAt: Date.now(),
      url: sourceUrl || ''
    }
  });

  appendDebugLog('background', 'Đã đọc currentProduct từ passive capture', {
    productKey: product.productKey,
    name: product.name,
    price: product.price_min || product.price,
    catid: product.catid
  });

  return product;
}

async function getCurrentProductFromDom(tabId, shopId, itemId, sourceUrl) {
  if (!tabId) {
    return null;
  }

  try {
    const rawItem = await executeMainWorldFunction(tabId, (targetShopId, targetItemId) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const meta = (selector) => document.querySelector(selector)?.getAttribute('content') || '';
      const parsePrice = (text) => {
        const s = String(text || '').replace(/\s+/g, ' ');
        const matches = [...s.matchAll(/(?:₫|đ)\s*([0-9][0-9.,]*)/gi)].map((m) => Number(String(m[1]).replace(/[^0-9]/g, ''))).filter((n) => n > 0);
        if (!matches.length) return 0;
        return matches.sort((a, b) => a - b)[0];
      };
      const parseSold = (text) => {
        const match = String(text || '').match(/đã\s*bán\s*([0-9.,]+)\s*([kK]|nghìn)?/i);
        if (!match) return 0;
        const n = Number(String(match[1]).replace(',', '.').replace(/[^0-9.]/g, '')) || 0;
        return Math.round(n * (match[2] ? 1000 : 1));
      };
      const parseRating = (text) => {
        const match = String(text || '').match(/([0-5](?:[.,]\d{1,2})?)\s*(?:trên\s*5|\/\s*5|sao|⭐)/i);
        return match ? Number(String(match[1]).replace(',', '.')) || 0 : 0;
      };

      const ogTitle = meta('meta[property="og:title"], meta[name="og:title"]');
      const h1 = clean(document.querySelector('h1')?.textContent || '');
      const title = clean(ogTitle || h1 || document.title).replace(/\s*\|\s*Shopee.*$/i, '').replace(/\s*-\s*Shopee.*$/i, '');
      const image = meta('meta[property="og:image"], meta[name="og:image"]');
      const bodyText = clean(document.body ? document.body.innerText.slice(0, 50000) : '');
      const price = parsePrice(bodyText);
      const sold = parseSold(bodyText);
      const rating = parseRating(bodyText);

      return {
        itemid: Number(targetItemId || 0),
        shopid: Number(targetShopId || 0),
        name: title,
        price,
        price_min: price,
        price_max: price,
        image,
        images: image ? [image] : [],
        historical_sold: sold,
        item_rating: rating ? { rating_star: rating, rating_count: [] } : undefined,
        source: 'dom-fallback'
      };
    }, [shopId, itemId]);

    const product = rawItem ? normalizeCurrentItem(rawItem, sourceUrl || '') : null;
    if (!product || !product.itemid || !product.shopid || !product.name) {
      return null;
    }

    await setStorage({
      [STORAGE_PRODUCT_KEY]: product,
      [STORAGE_STATUS_KEY]: {
        isProductPage: true,
        productKey: product.productKey,
        itemid: product.itemid,
        shopid: product.shopid,
        name: product.name,
        source: 'dom-fallback',
        updatedAt: Date.now(),
        url: sourceUrl || ''
      }
    });

    appendDebugLog('background', 'Đã đọc currentProduct từ DOM fallback', {
      productKey: product.productKey,
      name: product.name,
      price: product.price_min || product.price
    });

    return product;
  } catch (error) {
    appendDebugLog('background', 'DOM fallback lỗi', { tabId, error: error.message || String(error) });
    return null;
  }
}

async function getPassiveSearchCandidates(tabId, baseProduct) {
  const snapshot = await readPassiveSnapshot(tabId, baseProduct && baseProduct.shopid, baseProduct && baseProduct.itemid);
  const rawItems = Array.isArray(snapshot && snapshot.items) ? snapshot.items : [];
  const candidates = [];

  rawItems.forEach((raw) => {
    const product = normalizeSearchItem({ ...raw, source: 'passive-capture' });
    if (!product) return;
    if (baseProduct && Number(product.itemid) === Number(baseProduct.itemid) && Number(product.shopid) === Number(baseProduct.shopid)) return;
    candidates.push(product);
  });

  appendDebugLog('background', 'Passive candidates', {
    tabId,
    installed: snapshot && snapshot.installed,
    passiveTotal: snapshot && snapshot.count,
    candidateCount: candidates.length,
    preview: candidates.slice(0, 3).map((item) => ({ name: item.name, price: item.price_min || item.price, source: item.source }))
  });

  return candidates;
}

async function fetchJsonByDirectFetch(url, headers, label) {
  appendDebugLog('background', `${label}: direct fetch bắt đầu`, { url });

  const startedAt = Date.now();
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers
  });

  const text = await response.text();
  const elapsedMs = Date.now() - startedAt;
  let json = null;
  let parseError = '';

  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    parseError = error.message || String(error);
  }

  appendDebugLog('background', `${label}: direct fetch response`, {
    status: response.status,
    ok: response.ok,
    elapsedMs,
    contentType: response.headers.get('content-type'),
    parseError,
    bodyPreview: text.slice(0, 500)
  });

  if (!response.ok) {
    throw new Error(`${label} direct fetch lỗi HTTP ${response.status}. Body: ${text.slice(0, 160)}`);
  }

  if (parseError) {
    throw new Error(`${label} direct fetch trả về JSON lỗi: ${parseError}`);
  }

  return json;
}

async function fetchJsonByPageContext(tabId, url, headers, label) {
  appendDebugLog('background', `${label}: page-context fetch bắt đầu`, { tabId, url });

  const result = await executeScriptInMainWorld(tabId, {
    url,
    headers
  });

  appendDebugLog('background', `${label}: page-context fetch response`, {
    tabId,
    status: result.status,
    ok: result.ok,
    elapsedMs: result.elapsedMs,
    contentType: result.contentType,
    parseError: result.parseError,
    error: result.error,
    bodyPreview: String(result.bodyPreview || '').slice(0, 500)
  });

  if (!result.ok) {
    throw new Error(`${label} page-context fetch lỗi HTTP ${result.status || 0}. ${result.error || String(result.bodyPreview || '').slice(0, 160)}`);
  }

  if (result.parseError) {
    throw new Error(`${label} page-context fetch trả về JSON lỗi: ${result.parseError}`);
  }

  return result.json;
}

async function fetchJsonWithBestContext({ tabId, url, headers, label }) {
  if (tabId) {
    try {
      return await fetchJsonByPageContext(tabId, url, headers, label);
    } catch (pageError) {
      appendDebugLog('background', `${label}: page-context thất bại, thử direct fetch`, {
        tabId,
        error: pageError.message || String(pageError)
      });

      try {
        return await fetchJsonByDirectFetch(url, headers, label);
      } catch (directError) {
        throw new Error(`${label} thất bại. Page-context: ${pageError.message || String(pageError)} | Direct: ${directError.message || String(directError)}`);
      }
    }
  }

  return fetchJsonByDirectFetch(url, headers, label);
}

async function getCurrentProductFromPageContext(tabId, shopId, itemId, sourceUrl) {
  let apiError = null;

  try {
    const url = new URL(SHOPEE_ITEM_API);
    url.searchParams.set('itemid', String(itemId));
    url.searchParams.set('shopid', String(shopId));

    const json = await fetchJsonWithBestContext({
      tabId,
      url: url.toString(),
      label: 'Item API',
      headers: {
        accept: 'application/json',
        'x-api-source': 'pc'
      }
    });

    appendDebugLog('background', 'Item API JSON keys', {
      tabId,
      rootKeys: Object.keys(json || {}),
      dataKeys: Object.keys((json && json.data) || {}),
      hasItem: Boolean(json && json.data && json.data.item),
      error: json && json.error,
      errorMsg: json && json.error_msg
    });

    const rawItem = json && json.data && json.data.item;

    if (!rawItem || !(rawItem.itemid || rawItem.item_id) || !(rawItem.shopid || rawItem.shop_id)) {
      throw new Error('Item API không trả về dữ liệu sản phẩm hợp lệ.');
    }

    const product = normalizeCurrentItem({ ...rawItem, source: 'item-api' }, sourceUrl || '');

    await setStorage({
      [STORAGE_PRODUCT_KEY]: product,
      [STORAGE_STATUS_KEY]: {
        isProductPage: true,
        productKey: product.productKey,
        itemid: product.itemid,
        shopid: product.shopid,
        name: product.name,
        source: 'item-api',
        updatedAt: Date.now(),
        url: sourceUrl || ''
      }
    });

    appendDebugLog('background', 'Đã đọc và lưu currentProduct bằng item API', {
      productKey: product.productKey,
      name: product.name,
      price: product.price_min || product.price,
      catid: product.catid
    });

    return product;
  } catch (error) {
    apiError = error;
    appendDebugLog('background', 'Item API thất bại, chuyển sang passive/DOM fallback', {
      tabId,
      shopId,
      itemId,
      error: error.message || String(error)
    });
  }

  const passiveProduct = await getCurrentProductFromPassive(tabId, shopId, itemId, sourceUrl);
  if (passiveProduct) {
    return passiveProduct;
  }

  const domProduct = await getCurrentProductFromDom(tabId, shopId, itemId, sourceUrl);
  if (domProduct) {
    return domProduct;
  }

  throw new Error(`Không đọc được sản phẩm hiện tại. Item API: ${apiError ? apiError.message || String(apiError) : 'không rõ lỗi'} | Passive: không có dữ liệu | DOM: không trích được tên sản phẩm`);
}

async function fetchSearchItems(keyword, tabId, limit = SEARCH_API_LIMIT) {
  const url = new URL(SHOPEE_SEARCH_API);
  url.searchParams.set('by', 'relevancy');
  url.searchParams.set('keyword', keyword);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('newest', '0');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('page_type', 'search');
  url.searchParams.set('scenario', 'PAGE_GLOBAL_SEARCH');
  url.searchParams.set('version', '2');

  appendDebugLog('background', 'Bắt đầu gọi search API', {
    keyword,
    tabId,
    url: url.toString()
  });

  const json = await fetchJsonWithBestContext({
    tabId,
    url: url.toString(),
    label: `Search API keyword="${keyword}"`,
    headers: {
      accept: 'application/json',
      'x-api-source': 'pc'
    }
  });

  const items = Array.isArray(json && json.items) ? json.items : [];

  appendDebugLog('background', 'Search API JSON result', {
    keyword,
    total_count: json && json.total_count,
    itemCount: items.length,
    rootKeys: Object.keys(json || {}),
    error: json && json.error,
    errorMsg: json && json.error_msg,
    firstItemPreview: items[0] ? safeJson(items[0]) : null
  });

  return items;
}

async function findSimilarProducts(baseProduct, tabId, options = {}) {
  if (!baseProduct || !baseProduct.name) {
    throw new Error('Thiếu thông tin sản phẩm gốc để tìm kiếm.');
  }

  appendDebugLog('background', 'Find similar bắt đầu', {
    tabId,
    baseProduct: {
      itemid: baseProduct.itemid,
      shopid: baseProduct.shopid,
      name: baseProduct.name,
      price: baseProduct.price,
      price_min: baseProduct.price_min,
      catid: baseProduct.catid
    }
  });

  const searchMode = String(options.searchMode || 'wide');
  const requestedReturnLimit = Number(options.returnLimit || RETURN_RESULT_LIMIT);
  const effectiveReturnLimit = Math.min(Math.max(requestedReturnLimit || RETURN_RESULT_LIMIT, 10), 100);
  const effectiveSearchLimit = searchMode === 'very-wide' ? 100 : searchMode === 'standard' ? 60 : SEARCH_API_LIMIT;
  const effectiveKeywordLimit = searchMode === 'very-wide' ? 6 : searchMode === 'standard' ? 3 : MAX_KEYWORD_VARIANTS;
  const keywords = buildKeywordVariants(baseProduct.name).slice(0, effectiveKeywordLimit);

  if (!keywords.length) {
    throw new Error('Không tách được keyword từ tên sản phẩm hiện tại.');
  }

  const dedupedMap = new Map();
  const searchDebug = [];

  for (const keyword of keywords) {
    try {
      const rawItems = await fetchSearchItems(keyword, tabId, effectiveSearchLimit);
      searchDebug.push({ keyword, rawCount: rawItems.length, ok: true });

      rawItems.forEach((rawItem) => {
        const product = normalizeSearchItem(rawItem);

        if (!product) {
          return;
        }

        if (Number(product.itemid) === Number(baseProduct.itemid) && Number(product.shopid) === Number(baseProduct.shopid)) {
          appendDebugLog('background', 'Bỏ qua sản phẩm gốc trong search results', {
            itemid: product.itemid,
            shopid: product.shopid,
            name: product.name
          });
          return;
        }

        const key = `${product.shopid}_${product.itemid}`;
        if (!dedupedMap.has(key)) {
          dedupedMap.set(key, {
            ...product,
            matchedKeywords: [keyword]
          });
        } else {
          const existed = dedupedMap.get(key);
          if (!existed.matchedKeywords.includes(keyword)) {
            existed.matchedKeywords.push(keyword);
          }
        }
      });
    } catch (error) {
      searchDebug.push({ keyword, rawCount: 0, ok: false, error: error.message || String(error) });
      appendDebugLog('background', 'Search keyword thất bại', {
        keyword,
        error: error.message || String(error),
        stack: error.stack || ''
      });
    }

    if (SEARCH_DELAY_MS > 0) {
      await sleep(SEARCH_DELAY_MS);
    }
  }

  try {
    const passiveProducts = await getPassiveSearchCandidates(tabId, baseProduct);
    let addedPassive = 0;

    passiveProducts.forEach((product) => {
      const key = `${product.shopid}_${product.itemid}`;
      if (!dedupedMap.has(key)) {
        dedupedMap.set(key, {
          ...product,
          matchedKeywords: ['passive-capture']
        });
        addedPassive += 1;
      } else {
        const existed = dedupedMap.get(key);
        if (!existed.matchedKeywords.includes('passive-capture')) {
          existed.matchedKeywords.push('passive-capture');
        }
        existed.source = existed.source || 'api+passive';
      }
    });

    searchDebug.push({ keyword: 'passive-capture', rawCount: passiveProducts.length, added: addedPassive, ok: true });
  } catch (error) {
    searchDebug.push({ keyword: 'passive-capture', rawCount: 0, ok: false, error: error.message || String(error) });
    appendDebugLog('background', 'Passive search fallback thất bại', { error: error.message || String(error) });
  }

  const excludedProducts = [];
  const excludedPriceProducts = [];
  const eligibleProducts = Array.from(dedupedMap.values()).filter((product) => {
    const reason = getExcludedShopReason(product, baseProduct);

    if (reason) {
      excludedProducts.push({
        itemid: product.itemid,
        shopid: product.shopid,
        shop_name: product.shop_name || product.shopname || '',
        name: product.name,
        reason
      });
      return false;
    }

    const priceGap = getPriceGapInfo(baseProduct, product);
    if (!priceGap.ok) {
      excludedPriceProducts.push({
        itemid: product.itemid,
        shopid: product.shopid,
        shop_name: product.shop_name || product.shopname || '',
        name: product.name,
        basePrice: priceGap.basePrice,
        candidatePrice: priceGap.candidatePrice,
        diffPercent: priceGap.diffPercent,
        reason: priceGap.reason
      });
      return false;
    }

    return true;
  });

  if (excludedProducts.length) {
    appendDebugLog('background', 'Đã loại shop nội bộ khỏi kết quả', {
      excludedCount: excludedProducts.length,
      excludedShopKeywords: EXCLUDED_SHOP_KEYWORDS,
      sample: excludedProducts.slice(0, 12)
    });
  }

  if (excludedPriceProducts.length) {
    appendDebugLog('background', 'Đã loại sản phẩm lệch giá quá 50%', {
      excludedPriceCount: excludedPriceProducts.length,
      basePrice: getComparablePrice(baseProduct),
      sample: excludedPriceProducts.slice(0, 12)
    });
  }

  const candidates = eligibleProducts.map((product) => {
    const scoreResult = calculateSimilarityScore(baseProduct, product);
    return {
      ...product,
      score: scoreResult.score,
      scoreDetail: scoreResult.scoreDetail
    };
  });

  candidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return Number(a.price_min || a.price || 0) - Number(b.price_min || b.price || 0);
  });

  const topResults = candidates.slice(0, effectiveReturnLimit);

  appendDebugLog('background', 'Find similar hoàn tất', {
    keywords,
    searchDebug,
    dedupedCount: dedupedMap.size,
    excludedShopCount: excludedProducts.length,
    excludedPriceCount: excludedPriceProducts.length,
    hcmLocationBonus: 5,
    baseIsHcm: isBaseShopHcm(baseProduct),
    scoredCount: candidates.length,
    returnedCount: topResults.length,
    topPreview: topResults.slice(0, 3).map((item) => ({
      score: item.score,
      name: item.name,
      price: item.price_min || item.price,
      shop: item.shop_name,
      detail: item.scoreDetail
    }))
  });

  return {
    keywords,
    searchDebug,
    totalCandidates: candidates.length,
    excludedShopCount: excludedProducts.length,
    excludedPriceCount: excludedPriceProducts.length,
    excludedShopKeywords: EXCLUDED_SHOP_KEYWORDS,
    returnLimit: effectiveReturnLimit,
    searchApiLimit: effectiveSearchLimit,
    searchMode,
    keywordLimit: effectiveKeywordLimit,
    priceFilter: {
      basePrice: getComparablePrice(baseProduct),
      maxDiffPercent: 50,
      excludedCount: excludedPriceProducts.length
    },
    hcmLocationBonus: {
      enabled: isBaseShopHcm(baseProduct),
      points: 5
    },
    results: topResults
  };
}

function handleMessage(message, sender) {
  if (!message || !message.type) {
    return null;
  }

  if (message.type === 'PAGE_FETCH_CURRENT_PRODUCT_FROM_CONTENT') {
    const tabId = sender && sender.tab && sender.tab.id;

    appendDebugLog('background', 'Nhận PAGE_FETCH_CURRENT_PRODUCT_FROM_CONTENT', {
      tabId,
      shopId: message.shopId,
      itemId: message.itemId,
      directError: message.directError
    });

    if (!tabId) {
      throw new Error('Không xác định được tab để chạy page-context fetch.');
    }

    return getCurrentProductFromPageContext(tabId, message.shopId, message.itemId, message.sourceUrl)
      .then((product) => ({ ok: true, product }));
  }

  if (message.type === 'GET_CURRENT_PRODUCT_PAGE_FETCH') {
    appendDebugLog('background', 'Nhận GET_CURRENT_PRODUCT_PAGE_FETCH', {
      tabId: message.tabId,
      shopId: message.shopId,
      itemId: message.itemId
    });

    if (!message.tabId) {
      throw new Error('Thiếu tabId để đọc sản phẩm qua page-context.');
    }

    return getCurrentProductFromPageContext(message.tabId, message.shopId, message.itemId, message.sourceUrl)
      .then((product) => ({ ok: true, product }));
  }

  if (message.type === 'FIND_SIMILAR_PRODUCTS') {
    appendDebugLog('background', 'Nhận message FIND_SIMILAR_PRODUCTS', {
      tabId: message.tabId,
      hasProduct: Boolean(message.product),
      productName: message.product && message.product.name,
      options: message.options || {}
    });

    return findSimilarProducts(message.product, message.tabId, message.options || {})
      .then((payload) => ({
        ok: true,
        ...payload
      }));
  }

  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let job = null;

  try {
    job = handleMessage(message, sender);
  } catch (error) {
    appendDebugLog('background', 'Message handler lỗi đồng bộ', {
      type: message && message.type,
      error: error.message || String(error),
      stack: error.stack || ''
    });
    sendResponse({ ok: false, error: error.message || String(error) });
    return true;
  }

  if (!job) {
    return false;
  }

  Promise.resolve(job)
    .then((payload) => {
      appendDebugLog('background', 'Trả response ok', {
        type: message.type,
        ok: payload && payload.ok,
        resultCount: payload && payload.results && payload.results.length,
        keywords: payload && payload.keywords
      });
      sendResponse(payload);
    })
    .catch((error) => {
      appendDebugLog('background', 'Message handler lỗi', {
        type: message.type,
        error: error.message || String(error),
        stack: error.stack || ''
      });
      sendResponse({
        ok: false,
        error: error.message || String(error)
      });
    });

  return true;
});

appendDebugLog('background', 'Service worker loaded', {
  version: '1.1.1-sales-weighted-ranking'
});
