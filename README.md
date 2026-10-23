# infinite-canvas-ios

**[▶ Live demo](https://oventhebaker.github.io/Infinite-Canvas-IOS/)**: try it on your iPhone (add `?fps` for a frame meter).

A pannable, zoomable, optionally **endless** canvas for the web that actually
behaves on **iPhone Safari** — one dependency-free file (`infinite-canvas.js`,
~400 lines) and a demo page.

It was extracted from [petitbouquetin.fr](https://petitbouquetin.fr), a
portfolio laid out as an infinite map, after a long fight with iOS Safari.
The code is small; the value is in the **list of iOS traps below**, each one
found on a real iPhone and fixed where it's marked `iOS:` in the source.
If you are building anything you drag around with a finger, read the list
before you lose a week to it.

**Features:** one-finger pan · two-finger pinch zoom · iOS-like momentum ·
mouse drag, mouse-wheel zoom, trackpad pan & pinch · endless wrapping ·
eased "fly to" · links and buttons inside the canvas keep working.

## Quick start

```html
<div id="canvas" style="position:fixed; inset:0; overflow:hidden"></div>
<script src="infinite-canvas.js"></script>
<script>
  const canvas = new InfiniteCanvas(document.getElementById('canvas'), {
    period: { w: 2400, h: 2400 },  // repeat the world every 2400 px (omit for a bounded canvas)
    x: 1200, y: 1200, zoom: 0.6,   // the world point at the screen's centre
    minZoom: 0.4, maxZoom: 2,
  });

  const card = document.createElement('a');
  card.href = '/somewhere';
  card.textContent = 'Hello';
  canvas.add(card, 100, 100, 280, 300);   // x, y, width, height in world px

  canvas.flyTo(1200, 1200, 0.6);          // eased trip (e.g. a "back to centre" button)
</script>
```

Also copy the page-level CSS from `index.html` (`html, body { … }` and the
`--vh` script) — it matters on iOS, see trap 8.

| Option | Default | |
|---|---|---|
| `period` | `null` | `{ w, h }` to make the world repeat endlessly |
| `x`, `y`, `zoom` | `0, 0, 1` | starting camera |
| `minZoom`, `maxZoom` | `0.25, 2` | |
| `friction` | `0.002` | momentum decay per ms (iOS's own value) |
| `maxFlickSpeed` | `8` | screen px/ms cap on a flick |
| `seamFade` | `160` | world px over which a wrapped item fades as it changes copy |

`canvas.cam` is `{ x, y, zoom }`; set `canvas.onChange = (cam) => …` to follow
it. Mark an element `data-ic-native` to give it back the browser's own touch
handling (a scrollable panel), and `data-ic-tap` to make a non-link element
tappable.

Run the demo locally: serve the folder (`python3 -m http.server`) and open
`index.html` — add `?fps` to the address for a frame meter.

## The iOS Safari traps

Each one cost us real time. Symptom → cause → what the code does.

1. **A one-finger vertical drag moves Safari's address bar instead of the
   canvas**, and the pan feels clumsy (two fingers work fine).
   `touch-action: none` is not honoured for Safari's own gestures, and
   `preventDefault()` on `touchmove` comes too late — Safari decides who owns
   the touch at `touchstart`. → Non-passive `touchstart` **and** `touchmove`
   listeners that call `preventDefault()`, plus `preventDefault()` on
   `pointermove` for touch (since iOS 15, `touchmove` alone no longer stops
   Safari's pan). ([Apple's canvas guide](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/HTML-canvas-guide/AddingMouseandTouchControlstoCanvas/AddingMouseandTouchControlstoCanvas.html),
   [pqina](https://pqina.nl/blog/how-to-prevent-scrolling-the-page-on-ios-safari/))

2. **Links and buttons inside the canvas stop responding to taps.**
   A prevented `touchstart` also cancels the click the tap would produce.
   → On `touchend`, a finger that barely moved (< 10 px, < 600 ms) clicks
   the link/button it touched.

3. **One-finger drags stop after a few pixels**; the canvas then only
   coasts. On iOS, `setPointerCapture()` fires a `pointerleave`; ending the
   gesture on `pointerleave` killed every drag. → No `pointerleave` handler;
   the real lift arrives as `pointerup`/`pointercancel`.

4. **Pinch-zoom dies until reload** (one finger still pans). iOS sometimes
   never delivers a lifted finger's `pointerup`; the ghost stays tracked and
   the next real pinch counts as three fingers. → Any `isPrimary`
   `pointerdown` (first finger on an empty screen) clears stale pointers.

5. **Links can't be clicked after you add drag support.** Capturing the
   pointer on `pointerdown` retargets the click too. → Capture only once the
   pointer has moved 4 px (it's a drag, not a click).

6. **Twice the work on 120 Hz iPhones.** ProMotion delivers two
   `pointermove`s per frame; rendering on each one doubles the cost. → Moves
   are accumulated and applied once per `requestAnimationFrame`.

7. **"There's no momentum"** — or a fling after you stopped. A friction of
   1 %/ms stops the glide in ~0.1 s, too short to feel; and a finger that
   stops before lifting sends no more moves, so its old speed got applied.
   → iOS's own deceleration (speed × 0.998 per ms), and no momentum if the
   last move is older than 80 ms. `pointercancel` never flings.

8. **The toolbar slides in and out, the page rubber-bands.** `100vh` on iOS
   is the height *without* the toolbar. → `html, body { overflow: hidden;
   overscroll-behavior: none; height: calc(var(--vh) - 1px) }` with `--vh`
   synced to `window.innerHeight` — a page one pixel shorter than the window
   gives Safari nothing to scroll.
   ([pqina](https://pqina.nl/blog/how-to-prevent-scrolling-the-page-on-ios-safari/))

9. **"A problem repeatedly occurred on <site>"** — Safari kills the page.
   Two causes we hit:
   - `will-change: transform` (or `translate3d`) on the big world element.
     iOS then keeps a bitmap of its whole surface — hundreds of MB on a 3×
     screen. → The world is a 0×0 box with overflowing children, never
     promoted. Don't add `will-change` to it to "optimise".
   - A **blurred `box-shadow`** on elements that scale or fade on every
     frame of a pan. → No shadows on moving content on iOS (keep them for
     desktop if you like).
   The iOS Simulator **does not reproduce these** (it has the Mac's memory);
   only a real device does. We found the second one by publishing variants
   of the page, each with one feature removed, and trying them on the phone.

10. **Stutter when many items move at once.** Changing `opacity` on whole
    columns of off-screen items every frame (a wrap-seam fade) made Safari
    re-composite them all. → Items fade only when they can be seen, and the
    DOM is only written when a value actually changes.

11. **Safari caps page rendering near 60 fps** even on 120 Hz screens. Not
    fixable from a page: it's the user's *Prefer Page Rendering Updates near
    60fps* setting (Settings → Safari → Advanced → Feature Flags). Chrome and
    Firefox don't cap. Aim for a *steady* 60 rather than 120.
    ([WHATWG #5025](https://github.com/whatwg/html/issues/5025))

12. **Smaller things:** block `gesturestart`/`gesturechange` or Safari zooms
    the *page* on pinch; `-webkit-touch-callout: none` stops the long-press
    link menu; `-webkit-tap-highlight-color: transparent` removes the grey
    flash; `-webkit-user-drag: none` on images.

## Testing on iOS without going mad

- **The iOS Simulator** (Xcode → `xcrun simctl`) runs real WebKit: it
  reproduces the input bugs (1–5, 7, 8) faithfully. It does **not** enforce
  iPhone memory limits (trap 9) and its frame times are noisy — compare
  versions with several runs, not one.
- An `?fps` frame meter that only counts frames during a gesture tells you
  more than averages: count frames over 20 ms.
- To isolate a crash on a real phone: publish copies of the page with one
  suspect removed each, label them visibly, and try each one.
- Test in a **private tab**, with `?v=<something>` in the address: Safari
  happily keeps showing an old version.

## Licence

MIT — see [LICENSE](LICENSE). Made by Léonard Videt for
[Petit Bouquetin](https://petitbouquetin.fr).
