(function exposeJennyI18n(globalScope, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  if (globalScope && typeof globalScope === 'object') {
    var instance = api.createI18n();
    instance.SUPPORTED_TAGS = api.SUPPORTED_TAGS;
    instance.normalizeTag = api.normalizeTag;
    instance.dirForTag = api.dirForTag;
    instance.interpolate = api.interpolate;
    instance.createI18n = api.createI18n;
    globalScope.jennyI18n = instance;
    globalScope.jennyI18nFallback = function jennyI18nFallback(key, fallback, params) {
      return api.interpolate(fallback, params);
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function i18nUtilsFactory() {
  var SUPPORTED_TAGS = Object.freeze([
    'en',
    'es',
    'fr',
    'de',
    'it',
    'pt-BR',
    'nl',
    'pl',
    'ru',
    'uk',
    'tr',
    'ar',
    'hi',
    'id',
    'vi',
    'ja',
    'ko',
    'zh-CN',
    'zh-TW',
  ]);
  var SUPPORTED_BY_LOWER_TAG = Object.create(null);

  SUPPORTED_TAGS.forEach(function indexSupportedTag(tag) {
    SUPPORTED_BY_LOWER_TAG[tag.toLowerCase()] = tag;
  });

  function normalizeTag(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return 'en';
    }
    var lowerTag = value.trim().toLowerCase();
    if (lowerTag === 'qps-ploc') {
      return 'qps-ploc'; // pseudolocale: not user-selectable, but activatable for the owner walkthrough
    }
    if (lowerTag === 'pt' || lowerTag.indexOf('pt-') === 0) {
      return 'pt-BR';
    }
    if (lowerTag === 'zh' || lowerTag.indexOf('zh-') === 0) {
      if (
        lowerTag.indexOf('zh-hant') === 0 ||
        lowerTag === 'zh-tw' ||
        lowerTag.indexOf('zh-tw-') === 0 ||
        lowerTag === 'zh-hk' ||
        lowerTag.indexOf('zh-hk-') === 0 ||
        lowerTag === 'zh-mo' ||
        lowerTag.indexOf('zh-mo-') === 0
      ) {
        return 'zh-TW';
      }
      return 'zh-CN';
    }
    if (SUPPORTED_BY_LOWER_TAG[lowerTag]) {
      return SUPPORTED_BY_LOWER_TAG[lowerTag];
    }
    var primaryTag = lowerTag.split('-')[0];
    return SUPPORTED_BY_LOWER_TAG[primaryTag] || 'en';
  }

  function dirForTag(tag) {
    var primaryTag = typeof tag === 'string' ? tag.trim().toLowerCase().split('-')[0] : '';
    return primaryTag === 'ar' || primaryTag === 'he' || primaryTag === 'fa' || primaryTag === 'ur'
      ? 'rtl'
      : 'ltr';
  }

  function interpolate(template, params) {
    var values = params && (typeof params === 'object' || typeof params === 'function') ? params : {};
    return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, function replaceToken(token, name) {
      return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : token;
    });
  }

  function isPlainObject(value) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]') {
      return false;
    }
    var prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
  }

  function copyStringValues(source) {
    var result = Object.create(null);
    Object.keys(source).forEach(function copyStringValue(key) {
      if (typeof source[key] === 'string') {
        result[key] = source[key];
      }
    });
    return result;
  }

  function createI18n() {
    var activeTag = 'en';
    var strings = Object.create(null);
    var originalNodes = new WeakMap();
    var staticTargets = [
      { dataName: 'data-i18n', propertyName: 'textContent' },
      { dataName: 'data-i18n-title', attributeName: 'title' },
      { dataName: 'data-i18n-aria-label', attributeName: 'aria-label' },
      { dataName: 'data-i18n-placeholder', attributeName: 'placeholder' },
      { dataName: 'data-i18n-alt', attributeName: 'alt' },
    ];

    function load(catalog) {
      try {
        if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || !isPlainObject(catalog.strings)) {
          return false;
        }
        var nextStrings = copyStringValues(catalog.strings);
        activeTag = normalizeTag(catalog.tag);
        strings = nextStrings;
        return true;
      } catch (error) {
        return false;
      }
    }

    function tag() {
      return activeTag;
    }

    function dir() {
      return dirForTag(activeTag);
    }

    var use24HourTime = false;
    function setTimeFormat(enabled) { use24HourTime = enabled === true; }
    function timeOptions() { return use24HourTime ? { hourCycle: 'h23' } : {}; }

    function t(key, fallback, params) {
      var template = typeof key === 'string' && key && Object.prototype.hasOwnProperty.call(strings, key)
        ? strings[key]
        : fallback;
      return interpolate(template, params);
    }

    function tn(key, count, params, fallbackOne, fallbackOther) {
      var template;
      if (typeof key === 'string' && key) {
        var category = new Intl.PluralRules(activeTag).select(count);
        var candidates = [key + '#' + category, key + '#other', key];
        for (var index = 0; index < candidates.length; index += 1) {
          if (Object.prototype.hasOwnProperty.call(strings, candidates[index])) {
            template = strings[candidates[index]];
            break;
          }
        }
      }
      if (template === undefined) {
        template = new Intl.PluralRules('en').select(count) === 'one' ? fallbackOne : fallbackOther;
      }
      return interpolate(template, Object.assign({ count: count }, params || {}));
    }

    function rememberOriginals(node) {
      var originals = {};
      staticTargets.forEach(function rememberTarget(target) {
        if (node.hasAttribute(target.dataName)) {
          originals[target.dataName] = target.propertyName
            ? node[target.propertyName]
            : (node.getAttribute(target.attributeName) || '');
        }
      });
      originalNodes.set(node, originals);
      return originals;
    }

    function applyStaticTarget(node, target, originals) {
      var key = node.getAttribute(target.dataName);
      if (key === null) {
        return;
      }
      var translated = t(key, originals[target.dataName]);
      if (target.propertyName) {
        if (target.dataName === 'data-i18n' && node.children && node.children.length) {
          return;
        }
        node[target.propertyName] = translated;
      } else {
        node.setAttribute(target.attributeName, translated);
      }
    }

    function applyStaticNodes(root) {
      if (!root || typeof root.querySelectorAll !== 'function') {
        return 0;
      }
      var nodes = root.querySelectorAll(
        '[data-i18n],[data-i18n-title],[data-i18n-aria-label],[data-i18n-placeholder],[data-i18n-alt]'
      );
      Array.prototype.forEach.call(nodes, function applyStaticNode(node) {
        var originals = originalNodes.get(node) || rememberOriginals(node);
        staticTargets.forEach(function applyTarget(target) {
          applyStaticTarget(node, target, originals);
        });
      });
      return nodes.length;
    }

    return {
      load: load,
      tag: tag,
      setTimeFormat: setTimeFormat,
      timeOptions: timeOptions,
      dir: dir,
      t: t,
      tn: tn,
      applyStaticNodes: applyStaticNodes,
    };
  }

  return {
    SUPPORTED_TAGS: SUPPORTED_TAGS,
    normalizeTag: normalizeTag,
    dirForTag: dirForTag,
    interpolate: interpolate,
    createI18n: createI18n,
  };
});
