/*!
 * Immersive engine - Finesse Media
 * Scroll-scrubbed cinema scenes, generalized from the finessemedia.pro build.
 *
 * Every scene is configured in HTML with data attributes. See
 * references/engine.md in the immersive skill for the full attribute list.
 *
 * Progress model: a tall section ([data-im-scene]) contains a sticky
 * one-viewport stage (.im-stage). Scrolling through the section produces
 * progress p from 0 to 1. The film, every layer, and the CSS variable --im-p
 * are all pure functions of p.
 */
(function () {
  'use strict';

  var SEEK_TOLERANCE = 0.035;   // seconds; skip seeks smaller than ~1 frame at 24fps
  var END_GUARD = 0.045;        // never seek to the exact end (some browsers show black)
  var MOBILE_QUERY = '(max-width: 700px)';

  var doc = document;
  var root = doc.documentElement;
  var reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  var reduced = reducedQuery.matches;
  var ticking = false;
  var playback = null;          // { scene, video, frame, request }
  var playbackRequest = 0;
  var scenes = [];

  function clamp(n, min, max) {
    if (min === undefined) min = 0;
    if (max === undefined) max = 1;
    return Math.min(max, Math.max(min, n));
  }
  function range(el, attr, fallback) {
    var raw = el.getAttribute(attr);
    if (!raw) return fallback;
    return raw.split(',').map(function (v) { return parseFloat(v); });
  }
  function num(el, attr, fallback) {
    var v = parseFloat(el.getAttribute(attr));
    return Number.isFinite(v) ? v : fallback;
  }
  function all(scope, sel) { return Array.prototype.slice.call(scope.querySelectorAll(sel)); }

  /* ---------- Scene model ---------- */

  function buildScene(el) {
    var stage = el.querySelector('.im-stage');
    var video = el.querySelector('.im-film video');
    var scene = {
      el: el,
      stage: stage,
      video: video,
      filmWrap: video ? video.closest('.im-film') : null,
      videoRange: range(el, 'data-im-video-range', [0, 1]),
      playEnd: num(el, 'data-im-play-end', NaN),
      fadeOuts: all(el, '[data-im-fade-out]'),
      ranges: all(el, '[data-im-range]'),
      reveals: all(el, '[data-im-reveal]').map(function (r) { return { el: r, latched: false }; }),
      opacities: all(el, '[data-im-opacity]'),
      gotos: all(doc, '[data-im-goto]').filter(function (b) {
        var owner = b.getAttribute('data-im-for');
        return owner ? owner === el.id : el.contains(b);
      }),
      bar: el.querySelector('.im-progress > span'),
      status: el.querySelector('[data-im-status]'),
      target: 0,
      progress: 0,
      loading: null
    };
    if (video) wireVideo(scene);
    return scene;
  }

  function distance(scene) {
    return Math.max(1, scene.el.offsetHeight - scene.stage.offsetHeight);
  }
  function progressOf(scene) {
    return clamp(-scene.el.getBoundingClientRect().top / distance(scene));
  }
  function scrollToProgress(scene, p, behavior) {
    var top = scene.el.getBoundingClientRect().top + window.scrollY + p * distance(scene);
    window.scrollTo({ top: top, behavior: behavior || 'instant' });
  }

  /* ---------- Video loading and seek chasing ---------- */

  function showStatus(scene, message) {
    if (!scene.status) return;
    scene.status.hidden = !message;
    scene.status.textContent = message || '';
  }

  function pickSource(video) {
    var mobile = video.getAttribute('data-src-mobile');
    return mobile && window.matchMedia(MOBILE_QUERY).matches ? mobile : video.getAttribute('data-src');
  }

  function loadVideo(scene) {
    if (scene.loading) return scene.loading;
    var video = scene.video;
    var src = pickSource(video);
    if (!src) return Promise.reject(new Error('No data-src on scene video'));
    showStatus(scene, video.getAttribute('data-im-loading') || 'Loading the film\u2026');

    var useBlob = video.hasAttribute('data-im-blob');
    var sourceReady = useBlob
      ? fetch(src, { credentials: 'same-origin' }).then(function (res) {
          if (!res.ok) throw new Error('Film request failed');
          return res.blob();
        }).then(function (blob) {
          return URL.createObjectURL(new Blob([blob], { type: 'video/mp4' }));
        })
      : Promise.resolve(src);

    scene.loading = sourceReady.then(function (url) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { fail(); }, 45000);
        function done() { clearTimeout(timer); video.removeEventListener('loadeddata', ok); video.removeEventListener('error', fail); }
        function ok() { done(); resolve(); }
        function fail() { done(); if (useBlob) URL.revokeObjectURL(url); reject(new Error('Film could not decode')); }
        video.addEventListener('loadeddata', ok, { once: true });
        video.addEventListener('error', fail, { once: true });
        video.preload = 'auto';
        video.src = url;
        video.load();
      });
    }).then(function () {
      showStatus(scene, '');
    }).catch(function (err) {
      scene.loading = null;
      showStatus(scene, video.getAttribute('data-im-error') || 'The film could not load. Scroll to continue, or try Play again.');
      throw err;
    });
    return scene.loading;
  }

  function seek(scene) {
    var v = scene.video;
    if (!v || reduced) return;
    if (playback && playback.video === v) return;
    if (v.seeking || v.readyState < 1 || v.error) return;
    if (Math.abs(v.currentTime - scene.target) <= SEEK_TOLERANCE) return;
    try { v.currentTime = scene.target; } catch (e) { /* not seekable yet */ }
  }

  function wireVideo(scene) {
    var v = scene.video;
    v.muted = true;
    v.setAttribute('playsinline', '');
    v.addEventListener('seeked', function () { seek(scene); });
    v.addEventListener('canplay', function () { seek(scene); });
    v.addEventListener('loadedmetadata', function () { updateScene(scene); });
    v.addEventListener('loadeddata', function () {
      if (scene.filmWrap) scene.filmWrap.classList.add('is-ready');
      updateScene(scene);
    });
    v.addEventListener('error', function () {
      if (scene.filmWrap) scene.filmWrap.classList.remove('is-ready');
    });
  }

  /* ---------- Layer choreography ---------- */

  function setInert(el, value) {
    el.inert = value;
    el.style.pointerEvents = value ? 'none' : '';
  }

  function resetLayers(scene) {
    scene.fadeOuts.concat(scene.ranges, scene.opacities).forEach(function (el) {
      el.style.opacity = '';
      el.style.transform = '';
      el.classList.remove('is-active');
      setInert(el, false);
    });
    scene.el.style.removeProperty('--im-p');
    scene.el.style.removeProperty('--im-reveal');
    scene.reveals.forEach(function (r) {
      r.el.style.opacity = '';
      r.el.style.transform = '';
      setInert(r.el, false);
    });
  }

  function updateScene(scene) {
    if (reduced) { resetLayers(scene); return; }
    var p = progressOf(scene);
    scene.progress = p;
    scene.el.style.setProperty('--im-p', p.toFixed(4));

    // Hero-style layers: fade out and lift across [a,b], then go inert.
    scene.fadeOuts.forEach(function (el) {
      var r = range(el, 'data-im-fade-out', [0, 0.14]);
      var t = clamp((p - r[0]) / (r[1] - r[0]));
      el.style.opacity = String(1 - t);
      el.style.transform = 'translateY(' + (-t * num(el, 'data-im-lift', 28)) + 'px)';
      setInert(el, t >= 1);
    });

    // Chapter-style layers: visible inside [a,b] with soft edges.
    scene.ranges.forEach(function (el) {
      var r = range(el, 'data-im-range', [0, 1]);
      var edge = num(el, 'data-im-edge', 0.03);
      var o = Math.min(clamp((p - r[0]) / edge), clamp((r[1] - p) / edge));
      var active = p >= r[0] && p < r[1];
      el.style.opacity = String(o);
      el.classList.toggle('is-active', active);
      el.setAttribute('aria-hidden', String(!active));
      setInert(el, !active);
    });

    // Linear opacity ramps: data-im-opacity="a,b,from,to"
    scene.opacities.forEach(function (el) {
      var r = range(el, 'data-im-opacity', [0, 1, 1, 0]);
      var t = clamp((p - r[0]) / (r[1] - r[0]));
      el.style.opacity = String(r[2] + (r[3] - r[2]) * t);
    });

    // Portal-style reveals with latch: data-im-reveal="a,b" data-im-latch="0.28"
    var maxReveal = 0;
    scene.reveals.forEach(function (rv) {
      var el = rv.el;
      var r = range(el, 'data-im-reveal', [0.52, 0.74]);
      var latch = num(el, 'data-im-latch', NaN);
      if (Number.isFinite(latch)) {
        if (p > r[1]) rv.latched = true;
        if (p < latch) rv.latched = false;
      }
      var t = rv.latched ? 1 : clamp((p - r[0]) / (r[1] - r[0]));
      var from = num(el, 'data-im-scale-from', 0.78);
      var rise = num(el, 'data-im-rise', 40);
      el.style.opacity = String(t);
      el.style.transform = 'scale(' + (from + t * (1 - from)) + ') translateY(' + ((1 - t) * rise) + 'px)';
      setInert(el, t < 0.9);
      maxReveal = Math.max(maxReveal, t);
    });
    // Latch-aware reveal amount for CSS (e.g. keep the film dimmed while a HUD is open).
    scene.el.style.setProperty('--im-reveal', maxReveal.toFixed(4));

    // Chapter navigation state.
    scene.gotos.forEach(function (b) {
      var active = range(b, 'data-im-active', null);
      var on = active ? (p >= active[0] && p < active[1]) : false;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-current', on ? 'step' : 'false');
    });

    if (scene.bar) scene.bar.style.width = (p * 100) + '%';

    // Film: map [videoRange] of scroll to the full clip.
    var v = scene.video;
    if (v && Number.isFinite(v.duration) && v.duration > 0) {
      var vr = scene.videoRange;
      var vp = clamp((p - vr[0]) / (vr[1] - vr[0]));
      scene.target = vp * (v.duration - END_GUARD);
      seek(scene);
    }

    scene.el.dispatchEvent(new CustomEvent('im:progress', { detail: { progress: p } }));
  }

  function updateAll() {
    ticking = false;
    scenes.forEach(updateScene);
  }
  function requestUpdate() {
    if (!ticking) { ticking = true; requestAnimationFrame(updateAll); }
  }

  /* ---------- Reduced motion ---------- */

  function setReduced(value) {
    reduced = value;
    root.classList.toggle('im-reduced', value);
    all(doc, '[data-im-motion-toggle]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(value));
      b.textContent = value ? 'Enable motion' : 'Reduce motion';
    });
    if (value) stop();
    if (!value) scenes.forEach(function (s) { if (s.video && s.eager) loadVideo(s).catch(function () {}); });
    updateAll();
  }

  /* ---------- Play-through mode ---------- */

  function stop() {
    playbackRequest++;
    if (!playback) return;
    cancelAnimationFrame(playback.frame);
    playback.video.pause();
    playback = null;
    all(doc, '[data-im-playback]').forEach(function (el) { el.hidden = true; });
    updateAll();
  }

  function play(sceneId) {
    stop();
    var scene = scenes.filter(function (s) { return s.el.id === sceneId; })[0];
    if (!scene || !scene.video) return;
    if (reduced) setReduced(false);
    var request = playbackRequest;
    var video = scene.video;
    var overlay = doc.querySelector('[data-im-playback]');
    var label = doc.querySelector('[data-im-playback-label]');
    if (overlay) overlay.hidden = false;
    if (label) label.textContent = 'Loading\u2026';
    scene.reveals.forEach(function (r) { r.latched = false; });
    scrollToProgress(scene, 0);
    playback = { scene: scene, video: video, frame: 0 };

    loadVideo(scene).then(function () {
      if (request !== playbackRequest) return;
      video.currentTime = 0;
      if (label) label.textContent = scene.el.getAttribute('data-im-play-label') || 'Playing';
      return video.play();
    }).then(function () {
      if (request !== playbackRequest) { video.pause(); return; }
      var vr = scene.videoRange;
      var tick = function () {
        if (!playback || playback.video !== video) return;
        var vp = Number.isFinite(video.duration) ? clamp(video.currentTime / video.duration) : 0;
        scrollToProgress(scene, vr[0] + vp * (vr[1] - vr[0]));
        updateScene(scene);
        if (video.ended) {
          var end = Number.isFinite(scene.playEnd) ? scene.playEnd : vr[1];
          stop();
          scrollToProgress(scene, end);
          updateScene(scene);
          return;
        }
        playback.frame = requestAnimationFrame(tick);
      };
      playback.frame = requestAnimationFrame(tick);
    }).catch(function () {
      if (request !== playbackRequest) return;
      stop();
      showStatus(scene, 'Playback could not start. Scroll to explore, or try again.');
    });
  }

  /* ---------- Init ---------- */

  function init() {
    scenes = all(doc, '[data-im-scene]').map(buildScene);
    if (!scenes.length) return;

    // Eager: the first scene with a video, plus any marked data-im-eager.
    // Everything else lazy-loads when within ~900px of the viewport.
    var firstWithVideo = scenes.filter(function (s) { return s.video; })[0];
    scenes.forEach(function (s) {
      if (!s.video) return;
      s.eager = s === firstWithVideo || s.el.hasAttribute('data-im-eager');
      if (s.eager) {
        if (!reduced) loadVideo(s).catch(function () {});
        return;
      }
      var io = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; }) && !reduced) {
          loadVideo(s).catch(function () {});
          io.disconnect();
        }
      }, { rootMargin: '900px 0px' });
      io.observe(s.el);
    });

    all(doc, '[data-im-goto]').forEach(function (b) {
      b.addEventListener('click', function () {
        var owner = b.getAttribute('data-im-for');
        var scene = scenes.filter(function (s) { return owner ? s.el.id === owner : s.el.contains(b); })[0];
        if (!scene) return;
        stop();
        if (reduced) setReduced(false);
        scrollToProgress(scene, parseFloat(b.getAttribute('data-im-goto')), reducedQuery.matches ? 'instant' : 'smooth');
      });
    });
    all(doc, '[data-im-play]').forEach(function (b) {
      b.addEventListener('click', function () { play(b.getAttribute('data-im-play')); });
    });
    all(doc, '[data-im-stop]').forEach(function (b) { b.addEventListener('click', stop); });
    all(doc, '[data-im-motion-toggle]').forEach(function (b) {
      b.addEventListener('click', function () { setReduced(!reduced); });
    });

    // Any manual input cancels auto-play immediately.
    window.addEventListener('wheel', function () { if (playback) stop(); }, { passive: true });
    window.addEventListener('touchstart', function () { if (playback) stop(); }, { passive: true });
    doc.addEventListener('keydown', function (e) {
      if (playback && ['Escape', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].indexOf(e.key) > -1) stop();
    });
    doc.addEventListener('visibilitychange', function () { if (doc.hidden && playback) stop(); });

    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate);
    reducedQuery.addEventListener('change', function (e) { setReduced(e.matches); });

    setReduced(reduced);
  }

  window.Immersive = {
    refresh: updateAll,
    play: play,
    stop: stop,
    setReduced: setReduced,
    get scenes() { return scenes; }
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
