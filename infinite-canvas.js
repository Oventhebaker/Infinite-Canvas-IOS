/*!
 * infinite-canvas.js — a pannable, zoomable, optionally endless canvas that
 * behaves on iPhone. No dependencies. MIT licence.
 *
 * Every non-obvious line here is a workaround for something iOS Safari did
 * to us while building https://petitbouquetin.fr. Each one is marked
 * "iOS:" with the symptom it fixes, so you can tell what is safe to change.
 * The README lists them all in one place.
 *
 * Usage:
 *   const canvas = new InfiniteCanvas(document.getElementById('canvas'), {
 *     period: { w: 2400, h: 2400 },   // repeat the content every 2400 px (omit: no wrap)
 *     x: 1200, y: 1200, zoom: 1,       // starting camera (world point at screen centre)
 *     minZoom: 0.25, maxZoom: 2,
 *   });
 *   canvas.add(element, x, y, w, h);   // place a DOM element in world px
 *   canvas.flyTo(1200, 1200, 1);       // eased trip to a point
 */
(function (global) {
  'use strict';

  const DEFAULTS = {
    period: null,       // { w, h } to wrap the world (endless canvas), or null
    x: 0, y: 0, zoom: 1,
    minZoom: 0.25, maxZoom: 2,
    // iOS: UIScrollView's "normal" deceleration — speed keeps 99.8 % of
    // itself every millisecond. A stronger friction (we started at 1 %/ms)
    // stops the glide in ~0.1 s and it simply doesn't feel like momentum.
    friction: 0.002,
    maxFlickSpeed: 8,   // screen px/ms, so a mis-measured flick can't fling you away
    seamFade: 160,      // world px over which a wrapped item fades as it switches copy
    tapSlop: 10,        // px a finger may move and still count as a tap
    tapMaxMs: 600,
  };

  // A tap on these is recreated as a click (see _onTouchEnd).
  const TAPPABLE = 'a, button, input, select, textarea, label, [role="button"], [data-ic-tap]';
  const CAPTURE_THRESHOLD = 4;      // px before a press becomes a drag
  const PINCH_START_RATIO = 0.05;   // finger distance change before two fingers zoom
  const PINCH_WHEEL_RATE = 0.016;   // ctrl+wheel = trackpad pinch (Chrome/Firefox)
  const MOUSE_WHEEL_RATE = 0.0042;  // a mouse notch is ~100 px at once
  const OFFSCREEN_MARGIN = 600;     // world px beyond the view that still count as "visible"

  const mod = (a, n) => ((a % n) + n) % n;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  class InfiniteCanvas {
    constructor(root, options) {
      this.o = Object.assign({}, DEFAULTS, options);
      this.root = root;
      this.cam = { x: this.o.x, y: this.o.y, zoom: clamp(this.o.zoom, this.o.minZoom, this.o.maxZoom) };
      this.items = [];
      this.onChange = null;

      // The world is a 0×0 box: its children overflow it. Never give it (or
      // any other big element) will-change:transform or translate3d —
      // iOS: a compositing layer as large as the content is a bitmap of the
      // whole surface (hundreds of MB on a 3× screen); iOS kills the page
      // and Safari shows "A problem repeatedly occurred on <site>".
      this.world = document.createElement('div');
      this.world.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;';
      root.appendChild(this.world);

      // iOS: touch-action:none alone is NOT honoured for Safari's own
      // gestures (address bar, back swipe) — the listeners below are what
      // actually claim the touch. Still set it: it's what Chrome/Firefox use.
      root.style.touchAction = 'none';
      root.style.userSelect = root.style.webkitUserSelect = 'none';
      root.style.webkitTouchCallout = 'none'; // iOS: long-press link/image menu
      root.style.webkitTapHighlightColor = 'transparent';

      this._pointers = new Map();
      this._gesture = 'idle';   // 'idle' | 'pan' | 'twoFinger' | 'pinch'
      this._panDX = 0; this._panDY = 0;
      this._vel = null; this._fly = null; this._raf = 0;
      this._wheelHist = []; this._wheelKind = null;

      this._bind();
      this._schedule();
    }

    /* ── public API ─────────────────────────────────────────────────── */

    add(el, x, y, w, h) {
      el.style.position = 'absolute';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      const item = { el, x, y, w, h, ox: NaN, oy: NaN, op: 1 };
      this.items.push(item);
      this.world.appendChild(el);
      this._schedule();
      return item;
    }

    zoomAt(factor, screenX, screenY) {
      this._flushPan();
      const { width: W, height: H } = this._size();
      const z0 = this.cam.zoom;
      const z1 = clamp(z0 * factor, this.o.minZoom, this.o.maxZoom);
      if (z1 === z0) return;
      const wx = this.cam.x + (screenX - W / 2) / z0, wy = this.cam.y + (screenY - H / 2) / z0;
      this.cam.x = wx - (screenX - W / 2) / z1;
      this.cam.y = wy - (screenY - H / 2) / z1;
      this.cam.zoom = z1;
      this._schedule();
    }

    // An eased trip to (x, y) at zoom z. A long trip eases out a little on
    // the way (the zoom dips) so the travel stays readable instead of a blur.
    // With a period, it goes to the nearest copy of (x, y).
    flyTo(x, y, z = this.cam.zoom, duration) {
      this._flushPan();
      this._vel = null;
      const P = this.o.period, c = this.cam;
      const xT = P ? x + Math.round((c.x - x) / P.w) * P.w : x;
      const yT = P ? y + Math.round((c.y - y) / P.h) * P.h : y;
      const zT = clamp(z, this.o.minZoom, this.o.maxZoom);
      const { width: W, height: H } = this._size();
      const dist = Math.hypot(xT - c.x, yT - c.y);
      const zMid = Math.max(this.o.minZoom, Math.min(c.zoom, zT, 1.5 * Math.min(W, H) / Math.max(dist, 1)));
      const dip = Math.min(0, Math.log(zMid) - (Math.log(c.zoom) + Math.log(zT)) / 2);
      this._fly = { x0: c.x, y0: c.y, z0: c.zoom, xT, yT, zT, dip, t0: performance.now(), dur: duration || (dip < 0 ? 1400 : 900) };
      this._schedule();
    }

    destroy() {
      cancelAnimationFrame(this._raf);
      for (const [target, type, fn, opt] of this._listeners) target.removeEventListener(type, fn, opt);
      this.world.remove();
    }

    /* ── frame loop ─────────────────────────────────────────────────── */

    // ONE camera update + ONE DOM write per frame, whatever the input rate.
    // iOS: a 120 Hz iPhone sends two pointer moves per frame; rendering on
    // each one did twice the work for nothing. (Note: Safari also caps page
    // rendering near 60 fps by default — a user-side setting, not ours.)
    _schedule() { if (!this._raf) this._raf = requestAnimationFrame(this._frame); }

    _frame = (now) => {
      this._raf = 0;
      let animating = false;
      this._applyPan();

      if (this._vel) {
        const dt = Math.min(48, now - this._vel.t); // a backgrounded tab must not fling
        this._vel.t = now;
        this.cam.x -= this._vel.x * dt / this.cam.zoom;
        this.cam.y -= this._vel.y * dt / this.cam.zoom;
        const decay = Math.exp(-this.o.friction * dt);
        this._vel.x *= decay; this._vel.y *= decay;
        if (Math.hypot(this._vel.x, this._vel.y) > 0.02) animating = true; else this._vel = null;
      }

      if (this._fly) {
        const f = this._fly;
        const u = Math.min(1, (now - f.t0) / f.dur);
        const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
        this.cam.x = f.x0 + (f.xT - f.x0) * e;
        this.cam.y = f.y0 + (f.yT - f.y0) * e;
        this.cam.zoom = f.z0 * Math.pow(f.zT / f.z0, e) * Math.exp(f.dip * Math.sin(Math.PI * e));
        if (u < 1) animating = true; else this._fly = null;
      }

      this._render();
      if (animating) this._schedule();
    };

    _render() {
      const { width: W, height: H } = this._size();
      const { x, y, zoom } = this.cam;
      const P = this.o.period;
      // With a period, the world box sits at the camera's position modulo one
      // period, and every item is drawn at whichever copy of itself is
      // nearest the camera — when the box jumps by a period, every nearby
      // item's offset flips the opposite way in the same frame: nothing moves.
      const dx = P ? mod(x, P.w) : x, dy = P ? mod(y, P.h) : y;
      this.world.style.transform = `translate(${W / 2 - dx * zoom}px, ${H / 2 - dy * zoom}px) scale(${zoom})`;

      const viewW = W / (2 * zoom) + OFFSCREEN_MARGIN, viewH = H / (2 * zoom) + OFFSCREEN_MARGIN;
      for (const it of this.items) {
        const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
        let ox = 0, oy = 0, op = 1;
        if (P) {
          ox = P.w * Math.round((dx - cx) / P.w);
          oy = P.h * Math.round((dy - cy) / P.h);
          const rx = Math.abs(cx + ox - dx), ry = Math.abs(cy + oy - dy);
          // An item switches copy half a period from the camera; it fades
          // over the last seamFade px so the switch never pops. Only items
          // you can SEE fade. iOS: fading whole off-screen columns on every
          // frame made Safari re-composite them all and the pan stuttered.
          if (rx < viewW && ry < viewH) {
            const near = Math.max(rx - (P.w / 2 - this.o.seamFade), ry - (P.h / 2 - this.o.seamFade), 0);
            const t = 1 - Math.min(1, near / this.o.seamFade);
            op = Math.round(t * t * (3 - 2 * t) * 100) / 100;
          }
        }
        // Only touch the DOM when a value actually changed.
        if (ox !== it.ox || oy !== it.oy) {
          it.ox = ox; it.oy = oy;
          it.el.style.left = (it.x + ox) + 'px';
          it.el.style.top = (it.y + oy) + 'px';
        }
        if (op !== it.op) { it.op = op; it.el.style.opacity = op === 1 ? '' : op; }
      }
      if (this.onChange) this.onChange(this.cam);
    }

    _size() { return { width: this.root.clientWidth, height: this.root.clientHeight }; }

    /* ── panning, coalesced to the frame ────────────────────────────── */

    _panBy(dx, dy) { this._panDX += dx; this._panDY += dy; this._schedule(); }
    _applyPan() {
      if (!this._panDX && !this._panDY) return;
      this.cam.x -= this._panDX / this.cam.zoom;
      this.cam.y -= this._panDY / this.cam.zoom;
      this._panDX = this._panDY = 0;
    }
    // Anything that reads or rewrites the camera lands the pending pan first.
    _flushPan() { this._applyPan(); }

    /* ── listeners ──────────────────────────────────────────────────── */

    _bind() {
      const r = this.root;
      const on = (target, type, fn, opt) => { target.addEventListener(type, fn, opt); this._listeners.push([target, type, fn, opt]); };
      this._listeners = [];
      const active = { passive: false };
      on(r, 'pointerdown', this._onDown);
      on(r, 'pointermove', this._onMove, active);
      on(r, 'pointerup', this._onUp);
      on(r, 'pointercancel', this._onCancel);
      // iOS: no 'pointerleave' handler on purpose. setPointerCapture (below)
      // fires a pointerleave on iOS; treating it as a release ended every
      // one-finger drag a few px in — the canvas only coasted on momentum.
      on(r, 'touchstart', this._onTouchStart, active);
      on(r, 'touchmove', this._onTouchMove, active);
      on(r, 'touchend', this._onTouchEnd, active);
      // iOS / desktop Safari: a pinch fires these. Blocking them stops the
      // PAGE itself from zooming. The zoom comes from the pointers (touch)
      // or from ctrl+wheel (a Mac trackpad, Safari included) — not from
      // these, or a trackpad pinch in Safari would zoom twice.
      const block = (e) => e.preventDefault();
      on(r, 'gesturestart', block, active);
      on(r, 'gesturechange', block, active);
      on(r, 'wheel', this._onWheel, active);
      on(window, 'resize', () => this._schedule());
    }

    /* iOS: Safari decides at TOUCHSTART who owns the gesture. Calling
       preventDefault only on touchmove is too late: a one-finger vertical
       drag still moved Safari's address bar and the pan felt clumsy, while
       two fingers (claimed at touchstart) were smooth. So both are claimed
       here — pointer events still fire, so dragging is unaffected. */
    _onTouchStart = (e) => {
      if (this._native(e)) return;
      if (e.touches.length === 1) {
        const t = e.touches[0];
        this._tap = { x: t.clientX, y: t.clientY, at: performance.now(), target: e.target };
      } else {
        this._tap = null;
      }
      e.preventDefault();
    };
    _onTouchMove = (e) => { if (!this._native(e)) e.preventDefault(); };

    /* iOS: a prevented touchstart also cancels the click a tap would have
       produced — links and buttons inside the canvas went dead. A finger that
       went down and up without really moving clicks what it touched. */
    _onTouchEnd = (e) => {
      const tap = this._tap;
      this._tap = null;
      if (!tap || e.touches.length) return;
      const t = e.changedTouches[0];
      if (!t || Math.hypot(t.clientX - tap.x, t.clientY - tap.y) > this.o.tapSlop || performance.now() - tap.at > this.o.tapMaxMs) return;
      const el = tap.target && tap.target.closest && tap.target.closest(TAPPABLE);
      if (!el) return;
      e.preventDefault();
      if (el.matches('input, select, textarea')) el.focus(); else el.click();
    };

    // Elements marked data-ic-native (a scrollable panel inside the canvas…)
    // keep the browser's own touch behaviour.
    _native(e) { return !!(e.target.closest && e.target.closest('[data-ic-native]')); }

    _onDown = (e) => {
      if (this._native(e)) return;
      this._flushPan();
      this._vel = null; this._fly = null;
      // iOS: a lifted finger's pointerup sometimes never arrives. The ghost
      // stayed in the map, so the next real two-finger pinch counted as
      // THREE pointers and was ignored: one finger still panned, zoom was
      // dead until reload. The primary pointer is the first finger on an
      // empty screen (or the mouse): anything still tracked is a ghost.
      if (e.isPrimary && this._pointers.size) { this._pointers.clear(); this._gesture = 'idle'; this._panId = null; }
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pointers.size === 2) {
        if (this._panId != null && this.root.hasPointerCapture(this._panId)) this.root.releasePointerCapture(this._panId);
        this._panId = null;
        const [a, b] = this._pointers.values();
        this._startTwoFinger(a, b, 'twoFinger');
        return;
      }
      if (this._pointers.size !== 1) return; // a resting palm: tracked, otherwise ignored
      this._startPan(e.pointerId, e.clientX, e.clientY);
    };

    _startPan(id, x, y) {
      this._gesture = 'pan';
      this._panId = id;
      this._captured = false;
      this._down = { x, y };
      this._last = { x, y };
      this._moves = [{ x, y, t: performance.now() }];
    }

    // Two fingers don't zoom straight away: they pan by their midpoint until
    // their distance has changed enough to read as a deliberate pinch.
    _startTwoFinger(a, b, kind) {
      this._gesture = kind;
      this._pinch = { dist: Math.hypot(b.x - a.x, b.y - a.y), zoom: this.cam.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    }

    _onMove = (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      // iOS 15+: preventDefault on touchmove alone no longer stops Safari's
      // own pan; on pointermove it does.
      if (e.pointerType === 'touch') e.preventDefault();
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._gesture === 'twoFinger' || this._gesture === 'pinch') {
        const [a, b] = this._pointers.values();
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const p = this._pinch;
        if (this._gesture === 'twoFinger' && Math.abs(dist - p.dist) > Math.max(p.dist, 1) * PINCH_START_RATIO) {
          this._startTwoFinger(a, b, 'pinch'); // fresh baseline: the switch itself never jumps
          return;
        }
        if (this._gesture === 'pinch' && p.dist >= 1) {
          this.zoomAt(p.zoom * dist / p.dist / this.cam.zoom, mid.x, mid.y);
        }
        this._panBy(mid.x - p.mid.x, mid.y - p.mid.y);
        p.mid = mid;
        return;
      }

      if (this._gesture !== 'pan' || e.pointerId !== this._panId) return;
      if (!this._captured) {
        if (Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y) < CAPTURE_THRESHOLD) return;
        // Capture only once it's really a drag: capturing on pointerdown
        // retargets the click too, and links inside the canvas stop working.
        try { this.root.setPointerCapture(e.pointerId); } catch (err) { /* rare: pointer no longer active */ }
        this._captured = true;
      }
      this._panBy(e.clientX - this._last.x, e.clientY - this._last.y);
      this._last = { x: e.clientX, y: e.clientY };
      const now = performance.now();
      this._moves.push({ x: e.clientX, y: e.clientY, t: now });
      while (this._moves.length > 2 && now - this._moves[0].t > 80) this._moves.shift(); // the last ~80 ms
    };

    _onUp = (e) => this._end(e, true);
    // A cancel is the browser abandoning the touch, not a flick: no momentum.
    _onCancel = (e) => this._end(e, false);

    _end(e, allowMomentum) {
      if (!this._pointers.has(e.pointerId)) return;
      this._flushPan();
      const was = this._gesture;
      this._pointers.delete(e.pointerId);
      if (this.root.hasPointerCapture && this.root.hasPointerCapture(e.pointerId)) this.root.releasePointerCapture(e.pointerId);

      if (this._pointers.size >= 2) { const [a, b] = this._pointers.values(); this._startTwoFinger(a, b, was === 'pinch' ? 'pinch' : 'twoFinger'); return; }
      if (this._pointers.size === 1 && (was === 'pinch' || was === 'twoFinger')) {
        const [[id, p]] = this._pointers; // one finger left: carry on panning with it
        this._startPan(id, p.x, p.y);
        this._captured = true;
        return;
      }
      if (was === 'pan' && allowMomentum && this._captured && this._moves.length >= 2) {
        const a = this._moves[0], b = this._moves[this._moves.length - 1];
        const dt = b.t - a.t;
        // A finger that stops before lifting sends no more moves, so the
        // samples still hold the speed from before the stop: without this
        // check, "drag, hold, lift" flung the view anyway.
        const still = performance.now() - b.t > 80;
        if (!still && dt > 4 && dt < 200) {
          let vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt; // screen px/ms
          const s = Math.hypot(vx, vy), max = this.o.maxFlickSpeed;
          if (s > max) { vx *= max / s; vy *= max / s; }
          if (s > 0.05) { this._vel = { x: vx, y: vy, t: performance.now() }; this._schedule(); }
        }
      }
      if (!this._pointers.size) { this._gesture = 'idle'; this._panId = null; }
    }

    /* ── wheel & trackpad ───────────────────────────────────────────── */

    _onWheel = (e) => {
      e.preventDefault();
      this._vel = null; this._fly = null;
      clearTimeout(this._wheelTimer);
      this._wheelTimer = setTimeout(() => { this._wheelKind = null; this._wheelHist = []; }, 150);
      let kind;
      if (e.ctrlKey) kind = 'zoom'; // a trackpad pinch arrives as ctrl+wheel
      else if (this._wheelKind) kind = this._wheelKind;
      else {
        const c = this._classifyWheel(e);
        kind = c || 'zoom';
        if (c || this._wheelHist.length >= 10) this._wheelKind = kind;
      }
      if (kind === 'zoom') {
        const rate = e.ctrlKey ? PINCH_WHEEL_RATE : MOUSE_WHEEL_RATE;
        this.zoomAt(Math.exp(-e.deltaY * rate), e.clientX, e.clientY);
      } else {
        // Trackpad two-finger scroll pans 1:1 — macOS adds its own inertia.
        this._panBy(-e.deltaX, -e.deltaY);
      }
    };

    // A mouse wheel and a trackpad both send 'wheel'; tell them apart so the
    // wheel zooms and two fingers pan.
    _classifyWheel(e) {
      const h = this._wheelHist;
      h.push({ dy: Math.abs(e.deltaY), dx: Math.abs(e.deltaX), mode: e.deltaMode });
      if (h.length > 12) h.shift();
      if (h.some((s) => s.mode !== 0)) return 'zoom';                // line/page units: a mouse
      if (h.some((s) => s.dx > 0)) return 'pan';                     // any sideways: two fingers
      if (h.some((s) => s.dy >= 40)) return 'zoom';                  // a notch-sized step
      if (h.length >= 6 && h.every((s) => s.dy < 25)) return 'pan';  // steady small steps: two fingers
      return null;
    }
  }

  global.InfiniteCanvas = InfiniteCanvas;
})(typeof window !== 'undefined' ? window : this);
