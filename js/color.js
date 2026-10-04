// ジャケットから背景色と文字色を決める。

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hsl = (h, s, l) => `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;

export const DEFAULT = { bg: '#17191c', fg: '#f1efe9', tone: 'dark' };

export async function paletteFrom(url) {
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    await img.decode();

    const N = 40;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = N;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, N, N);
    const px = ctx.getImageData(0, 0, N, N).data;

    // 近い色をまとめて数える（各チャンネル8段階）
    const buckets = new Map();
    for (let i = 0; i < px.length; i += 4) {
      const key = (px[i] >> 5) << 6 | (px[i + 1] >> 5) << 3 | (px[i + 2] >> 5);
      const b = buckets.get(key) || [0, 0, 0, 0];
      b[0] += px[i]; b[1] += px[i + 1]; b[2] += px[i + 2]; b[3]++;
      buckets.set(key, b);
    }
    const colors = [...buckets.values()].map(([r, g, b, n]) => ({ n, hsl: rgbToHsl(r / n, g / n, b / n) }));

    // 背景: いちばん面積の広い色
    const [h, s, l] = colors.reduce((a, b) => (b.n > a.n ? b : a)).hsl;

    if (l > 0.72) {
      // 白っぽいジャケットは明るい画面のままにする
      return { bg: hsl(h, Math.min(s, 0.5), clamp(l, 0.82, 0.92)), fg: hsl(h, Math.min(s, 0.4), 0.13), tone: 'light' };
    }

    // 文字: ジャケットの中でいちばん目立つ鮮やかな色を、読める明るさまで持ち上げる
    const accent = colors
      .filter((c) => c.hsl[2] > 0.35)
      .reduce((a, c) => (c.hsl[1] * Math.sqrt(c.n) > (a ? a.hsl[1] * Math.sqrt(a.n) : 0) ? c : a), null);
    const fg = accent && accent.hsl[1] > 0.15
      ? hsl(accent.hsl[0], Math.min(accent.hsl[1], 0.5), 0.9)
      : hsl(h, 0.1, 0.93);

    return { bg: hsl(h, Math.min(s, 0.6), clamp(l, 0.12, 0.26)), fg, tone: 'dark' };
  } catch {
    return DEFAULT;
  }
}
