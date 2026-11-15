// Küçük, bağımlılıksız NBT okuyucu (Minecraft'ın ikili veri biçimi; yalnızca okuma).
// Uzun diziler (TAG_Long_Array) { longs: Buffer, length } olarak döner (bkz. packed.js); harita yalnızca blok ve
// yükseklik verisini kullanır.
'use strict';

function parse(buf) {
    let pos = 0;
    const u8 = () => buf[pos++];
    const i16 = () => { const v = buf.readInt16BE(pos); pos += 2; return v; };
    const u16 = () => { const v = buf.readUInt16BE(pos); pos += 2; return v; };
    const i32 = () => { const v = buf.readInt32BE(pos); pos += 4; return v; };
    const str = () => { const n = u16(); const s = buf.toString('utf8', pos, pos + n); pos += n; return s; };

    function payload(type) {
        switch (type) {
            case 1: { const v = buf.readInt8(pos); pos += 1; return v; }
            case 2: return i16();
            case 3: return i32();
            case 4: { const v = buf.readBigInt64BE(pos); pos += 8; return v; }
            case 5: { const v = buf.readFloatBE(pos); pos += 4; return v; }
            case 6: { const v = buf.readDoubleBE(pos); pos += 8; return v; }
            case 7: { const n = i32(); const v = buf.subarray(pos, pos + n); pos += n; return v; }
            case 8: return str();
            case 9: {
                const t = u8(), n = i32(), list = new Array(Math.max(0, n));
                for (let i = 0; i < n; i++) list[i] = payload(t);
                return list;
            }
            case 10: {
                const obj = {};
                for (;;) {
                    const t = u8();
                    if (t === 0) return obj;
                    const name = str();
                    obj[name] = payload(t);
                }
            }
            case 11: {
                const n = i32(), arr = new Int32Array(n);
                for (let i = 0; i < n; i++) arr[i] = i32();
                return arr;
            }
            case 12: {
                // Ham baytlar (büyük sonlu, uzun başına 8 bayt): BigInt'e çevirmek haritada en pahalı adım olurdu
                const n = i32(); const v = { longs: buf.subarray(pos, pos + n * 8), length: n }; pos += n * 8;
                return v;
            }
            default: throw new Error('Bilinmeyen NBT türü: ' + type);
        }
    }

    const type = u8();
    if (type !== 10) throw new Error('NBT kökü bir bileşik değil.');
    str();
    return payload(10);
}

module.exports = { parse };
