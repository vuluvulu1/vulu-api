// Anvil bölge dosyası (r.X.Z.mca): 32×32 parçalık (chunk) bir alan. İlk 4 KB parçaların yerleri, sonraki 4 KB son
// kaydedilme zamanları. Harita bu zamanlarla yalnızca değişen parçaları yeniden çizer.
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const nbt = require('./nbt');

const SECTOR = 4096;

/** Başlık: her parça için dosyadaki yeri ve son kaydedilme zamanı (saniye, 0 = parça yok). */
function readHeader(fd) {
    const head = Buffer.alloc(SECTOR * 2);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    if (n < head.length) return null;
    const chunks = new Array(1024);
    for (let i = 0; i < 1024; i++) {
        const loc = head.readUInt32BE(i * 4);
        chunks[i] = { offset: (loc >>> 8) * SECTOR, sectors: loc & 0xff, time: head.readUInt32BE(SECTOR + i * 4) };
    }
    return chunks;
}

/** Bir parçanın NBT'si; okunamazsa (sunucu o an yazıyor olabilir) null — bir sonraki turda yeniden denenir. */
function readChunk(fd, entry) {
    if (!entry.offset || !entry.sectors) return null;
    const raw = Buffer.alloc(entry.sectors * SECTOR);
    if (fs.readSync(fd, raw, 0, raw.length, entry.offset) < 5) return null;
    const length = raw.readUInt32BE(0), kind = raw[4];
    if (length < 1 || length > raw.length - 4) return null;
    if (kind & 0x80) return null;   // parça ayrı bir dosyada (.mcc): çok büyük parçalar, haritada atlanır
    const body = raw.subarray(5, 4 + length);
    try {
        const data = kind === 2 ? zlib.inflateSync(body) : kind === 1 ? zlib.gunzipSync(body) : kind === 3 ? body : null;
        return data ? nbt.parse(data) : null;
    } catch { return null; }
}

module.exports = { readHeader, readChunk };
