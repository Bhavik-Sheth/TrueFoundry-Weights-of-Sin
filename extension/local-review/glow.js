function animateGlow(canvas) {
  const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ss = (t) => {
    const c = clamp(t);
    return c * c * (3 - 2 * c);
  };

  const C_CORE = [143, 213, 241]; // #8fd5f1
  const C_RIM = [210, 218, 255];  // #d2daff

  const ctx = canvas.getContext('2d');

  if (!ctx) return;

  // 10-key scroll interpolation table: [q, tip, half, soft]
  const KEYS = [
    [0.00, 0.30, 0.34, 0.22],
    [0.03, 0.45, 0.38, 0.26],
    [0.08, 0.65, 0.38, 0.22],
    [0.18, 0.80, 0.38, 0.22],
    [0.40, 0.95, 0.38, 0.19],
    [0.66, 1.05, 0.46, 0.16],
    [0.87, 1.05, 0.66, 0.13],
    [1.15, 1.10, 0.90, 0.10],
    [1.43, 1.30, 1.60, 0.10],
    [1.80, 2.40, 3.00, 0.10],
  ];

  function sampleKeys(q) {
    if (q <= KEYS[0][0]) return { tip: KEYS[0][1], half: KEYS[0][2], soft: KEYS[0][3] };
    const last = KEYS[KEYS.length - 1];
    if (q >= last[0]) return { tip: last[1], half: last[2], soft: last[3] };
    for (let i = 0; i < KEYS.length - 1; i++) {
      const a = KEYS[i];
      const b = KEYS[i + 1];
      if (q <= b[0]) {
        const t = (q - a[0]) / (b[0] - a[0]);
        return {
          tip: lerp(a[1], b[1], t),
          half: lerp(a[2], b[2], t),
          soft: lerp(a[3], b[3], t),
        };
      }
    }
    return { tip: last[1], half: last[2], soft: last[3] };
  }

  const cur = { tip: -0.3, half: 0.3, soft: 0.1 };
  let tgt = { tip: 0.3, half: 0.34, soft: 0.22 };

  const W = 96;
  const H = 60;
  const N = 48;
  const RND = 0.25;
  const imgData = ctx.createImageData(W, H);
  const pixels = imgData.data;
  const cxArr = new Float32Array(N);
  const cyArr = new Float32Array(N);
  const dxArr = new Float32Array(N - 1);
  const dyArr = new Float32Array(N - 1);
  const invLenSqArr = new Float32Array(N - 1);

  function drawBowl(tipVal, halfVal, softVal) {
    const vw = canvas.clientWidth || 96;
    const vh = canvas.clientHeight || 60;
    const aspect = vw / Math.max(1, vh);
    const halfA = halfVal * aspect;
    const inv2Soft = 1 / (2 * Math.max(0.001, softVal));

    if (tipVal <= 0.002) {
      const rndEff = RND * clamp((tipVal + 0.3) / 0.15);
      let idx = 0;
      for (let y = 0; y < H; y++) {
        const py = (y + 0.5) / H;
        const sd = (py - tipVal) - rndEff;
        const g = 1 - ss((sd + softVal) * inv2Soft);
        let r, gr, b;
        if (g < 0.38) {
          const m = ss(g / 0.38);
          r = 255 + (C_RIM[0] - 255) * m;
          gr = 255 + (C_RIM[1] - 255) * m;
          b = 255 + (C_RIM[2] - 255) * m;
        } else {
          const m = ss((g - 0.38) / 0.62);
          r = C_RIM[0] + (C_CORE[0] - C_RIM[0]) * m;
          gr = C_RIM[1] + (C_CORE[1] - C_RIM[1]) * m;
          b = C_RIM[2] + (C_CORE[2] - C_RIM[2]) * m;
        }
        const ri = (r + 0.5) | 0;
        const gi = (gr + 0.5) | 0;
        const bi = (b + 0.5) | 0;
        for (let x = 0; x < W; x++) {
          pixels[idx++] = ri;
          pixels[idx++] = gi;
          pixels[idx++] = bi;
          pixels[idx++] = 255;
        }
      }
      ctx.putImageData(imgData, 0, 0);
      return;
    }

    const yStart = -0.3;
    const ySpan = tipVal - yStart;
    const invTip = 1 / tipVal;
    for (let i = 0; i < N; i++) {
      const yy = yStart + (i / (N - 1)) * ySpan;
      const base = 1 - yy * invTip;
      cxArr[i] = base > 0 ? halfA * Math.pow(base, 0.72) : 0;
      cyArr[i] = yy;
    }
    for (let i = 0; i < N - 1; i++) {
      const dx = cxArr[i + 1] - cxArr[i];
      const dy = cyArr[i + 1] - cyArr[i];
      dxArr[i] = dx;
      dyArr[i] = dy;
      const lsq = dx * dx + dy * dy;
      invLenSqArr[i] = lsq > 1e-12 ? 1 / lsq : 0;
    }

    let idx = 0;
    for (let y = 0; y < H; y++) {
      const py = (y + 0.5) / H;
      const insideBound = py < tipVal ? halfA * Math.pow(1 - py * invTip, 0.72) : -1;

      for (let x = 0; x < W; x++) {
        const px = Math.abs((x + 0.5) / W - 0.5) * aspect;

        let minD2 = 1e9;
        for (let i = 0; i < N - 1; i++) {
          const vx = px - cxArr[i];
          const vy = py - cyArr[i];
          const dx = dxArr[i];
          const dy = dyArr[i];
          let proj = (vx * dx + vy * dy) * invLenSqArr[i];
          if (proj < 0) proj = 0;
          else if (proj > 1) proj = 1;
          const ex = vx - dx * proj;
          const ey = vy - dy * proj;
          const d2 = ex * ex + ey * ey;
          if (d2 < minD2) minD2 = d2;
        }

        const dist = Math.sqrt(minD2);
        const inside = px < insideBound;
        const sd = (inside ? -dist : dist) - RND;
        const g = 1 - ss((sd + softVal) * inv2Soft);

        let r, gr, b;
        if (g < 0.38) {
          const m = ss(g / 0.38);
          r = 255 + (C_RIM[0] - 255) * m;
          gr = 255 + (C_RIM[1] - 255) * m;
          b = 255 + (C_RIM[2] - 255) * m;
        } else {
          const m = ss((g - 0.38) / 0.62);
          r = C_RIM[0] + (C_CORE[0] - C_RIM[0]) * m;
          gr = C_RIM[1] + (C_CORE[1] - C_RIM[1]) * m;
          b = C_RIM[2] + (C_CORE[2] - C_RIM[2]) * m;
        }

        pixels[idx++] = (r + 0.5) | 0;
        pixels[idx++] = (gr + 0.5) | 0;
        pixels[idx++] = (b + 0.5) | 0;
        pixels[idx++] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  function onScroll() {
    const vh = window.innerHeight || 900;
    const q = window.scrollY / vh;
    tgt = sampleKeys(q);
  }

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    drawBowl(0.3, 0.34, 0.22);
    return;
  }
  let visible = true;
  const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
  observer.observe(canvas);
  let frame;
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });

  frame = requestAnimationFrame((startTime) => {
    onScroll();
    const INTRO_DELAY = 250;
    const INTRO_DUR = 1050;

    function tick(now) {
      const elapsed = now - startTime;
      let driftScale = 1;

      if (elapsed < INTRO_DELAY + INTRO_DUR) {
        onScroll();
        const u = elapsed < INTRO_DELAY ? 0 : ss((elapsed - INTRO_DELAY) / INTRO_DUR);
        cur.tip = lerp(-0.3, tgt.tip, u);
        cur.half = lerp(0.3, tgt.half, u);
        cur.soft = lerp(0.1, tgt.soft, u);
        driftScale = u;
      } else {
        cur.tip += (tgt.tip - cur.tip) * 0.12;
        cur.half += (tgt.half - cur.half) * 0.12;
        cur.soft += (tgt.soft - cur.soft) * 0.12;
      }

      const renderTip = cur.tip + Math.sin(now * 0.00033 + 1.3) * 0.02 * driftScale;
      const renderHalf = cur.half + Math.sin(now * 0.0005) * 0.015 * driftScale;
      if (visible && !document.hidden) drawBowl(renderTip, renderHalf, cur.soft);

      frame = requestAnimationFrame(tick);
    }

    frame = requestAnimationFrame(tick);
  });
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
  };
}

customElements.define('contexo-glow', class extends HTMLElement {
  connectedCallback() {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 60;
    this.replaceChildren(canvas);
    this.stop = animateGlow(canvas);
  }
  disconnectedCallback() { this.stop?.(); }
});
