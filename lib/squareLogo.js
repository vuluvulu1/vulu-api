const { PNG } = require('pngjs');

const MAX_SIDE = 1024;      // Discord küçük gösterir; büyük logolar önce bu boyuta indirilir
const MARGIN = 0.08;        // logonun çevresinde bırakılan boşluk (kenar uzunluğuna oranla)

/** RGBA görüntüyü alan ortalamasıyla küçültür (en uzun kenar en fazla MAX_SIDE). */
function shrink(src) {
    const factor = Math.ceil(Math.max(src.width, src.height) / MAX_SIDE);
    if (factor <= 1) return src;
    const w = Math.max(1, Math.floor(src.width / factor)), h = Math.max(1, Math.floor(src.height / factor));
    const out = { width: w, height: h, data: Buffer.alloc(w * h * 4) };
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let dy = 0; dy < factor; dy++) {
                const sy = y * factor + dy;
                if (sy >= src.height) break;
                for (let dx = 0; dx < factor; dx++) {
                    const sx = x * factor + dx;
                    if (sx >= src.width) break;
                    const i = (sy * src.width + sx) * 4, al = src.data[i + 3];
                    r += src.data[i] * al; g += src.data[i + 1] * al; b += src.data[i + 2] * al; a += al; n++;
                }
            }
            const o = (y * w + x) * 4;
            if (a > 0) { out.data[o] = Math.round(r / a); out.data[o + 1] = Math.round(g / a); out.data[o + 2] = Math.round(b / a); }
            out.data[o + 3] = Math.round(a / n);
        }
    }
    return out;
}

/**
 * PNG logoyu şeffaf, kare bir zeminin ortasına yerleştirir (Discord büyük resmi kareye kırptığı için).
 * PNG değilse ya da okunamazsa null döner.
 */
function squareLogo(buffer) {
    let src;
    try { src = PNG.sync.read(buffer); } catch { return null; }
    if (!src.width || !src.height) return null;
    const img = shrink(src);
    const side = Math.ceil(Math.max(img.width, img.height) * (1 + 2 * MARGIN));
    const out = new PNG({ width: side, height: side });              // şeffaf başlar
    const ox = Math.floor((side - img.width) / 2), oy = Math.floor((side - img.height) / 2);
    for (let y = 0; y < img.height; y++)
        img.data.copy(out.data, ((oy + y) * side + ox) * 4, y * img.width * 4, (y + 1) * img.width * 4);
    return PNG.sync.write(out, { colorType: 6 });
}

module.exports = { squareLogo };
