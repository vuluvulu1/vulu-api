// Harita renkleri: blok adı → [r, g, b]. Sık görülen bloklar tek tek, gerisi adındaki kelimelere göre.
// Modların blokları da adlarından tahmin edilir (…_log, …_leaves, …_stone gibi); tanınmayanlar gri.
'use strict';

const EXACT = {
    grass_block: [110, 158, 66], short_grass: [110, 158, 66], tall_grass: [110, 158, 66], fern: [96, 145, 60], large_fern: [96, 145, 60],
    dirt: [134, 96, 67], coarse_dirt: [119, 85, 59], rooted_dirt: [144, 103, 76], podzol: [91, 63, 24], mycelium: [111, 99, 105],
    dirt_path: [148, 121, 65], farmland: [96, 62, 38], mud: [60, 57, 60], clay: [160, 166, 179], moss_block: [89, 109, 45],
    sand: [219, 207, 163], red_sand: [190, 102, 33], sandstone: [216, 203, 155], red_sandstone: [186, 99, 29], gravel: [131, 127, 126],
    stone: [125, 125, 125], cobblestone: [122, 122, 122], mossy_cobblestone: [110, 118, 94], andesite: [136, 136, 137], diorite: [188, 188, 188],
    granite: [149, 103, 85], deepslate: [80, 80, 82], tuff: [108, 109, 102], calcite: [223, 224, 220], dripstone_block: [134, 107, 92],
    bedrock: [85, 85, 85], obsidian: [15, 10, 24], netherrack: [97, 38, 38], soul_sand: [81, 62, 50], soul_soil: [75, 57, 46],
    basalt: [80, 81, 86], blackstone: [42, 36, 41], crimson_nylium: [130, 31, 31], warped_nylium: [43, 114, 101], glowstone: [171, 131, 84],
    end_stone: [219, 222, 158], purpur_block: [169, 125, 169], magma_block: [142, 63, 31],
    water: [63, 118, 228], lava: [207, 92, 15], ice: [145, 183, 253], packed_ice: [141, 180, 250], blue_ice: [116, 167, 253],
    snow: [249, 254, 254], snow_block: [249, 254, 254], powder_snow: [248, 253, 253],
    oak_leaves: [77, 120, 38], spruce_leaves: [60, 95, 60], birch_leaves: [107, 141, 70], jungle_leaves: [48, 135, 25],
    acacia_leaves: [90, 130, 30], dark_oak_leaves: [58, 100, 25], mangrove_leaves: [70, 120, 30], cherry_leaves: [229, 172, 194],
    azalea_leaves: [90, 115, 45], flowering_azalea_leaves: [110, 120, 70], pale_oak_leaves: [160, 165, 150],
    lily_pad: [32, 128, 48], kelp: [70, 140, 40], seagrass: [60, 130, 40], tall_seagrass: [60, 130, 40], sugar_cane: [148, 192, 101],
    cactus: [85, 127, 43], pumpkin: [198, 118, 24], melon: [111, 145, 30], hay_block: [166, 136, 38], bamboo: [93, 144, 19],
    glass: [200, 220, 230], torch: [255, 200, 90], lantern: [220, 170, 90], bricks: [150, 97, 83], bookshelf: [117, 94, 60],
    crafting_table: [120, 80, 50], chest: [160, 110, 50], barrel: [120, 85, 50], furnace: [110, 110, 110],
};

const COLORS = {
    white: [234, 236, 237], orange: [241, 118, 20], magenta: [190, 69, 180], light_blue: [58, 175, 217], yellow: [249, 198, 40],
    lime: [112, 185, 26], pink: [238, 141, 172], gray: [63, 68, 72], light_gray: [142, 142, 135], cyan: [21, 138, 145],
    purple: [122, 42, 173], blue: [53, 57, 157], brown: [114, 72, 41], green: [85, 110, 28], red: [161, 39, 35], black: [21, 21, 26],
};

const WOOD = {
    oak: [162, 131, 79], spruce: [115, 85, 49], birch: [196, 179, 123], jungle: [160, 115, 81], acacia: [168, 90, 50],
    dark_oak: [67, 43, 20], mangrove: [118, 54, 49], cherry: [226, 178, 172], bamboo: [194, 173, 80], crimson: [101, 48, 70],
    warped: [43, 105, 99], pale_oak: [230, 222, 220],
};

const cache = new Map();

function guess(name) {
    if (EXACT[name]) return EXACT[name];
    for (const [c, rgb] of Object.entries(COLORS).sort((a, b) => b[0].length - a[0].length))
        if (name.startsWith(c + '_') && /(wool|concrete|terracotta|carpet|glass|bed|banner|candle|shulker)/.test(name))
            return name.includes('terracotta') ? rgb.map(v => Math.round(v * 0.72 + 40)) : rgb;
    if (name.includes('leaves')) return [70, 115, 40];
    if (name.includes('water')) return EXACT.water;
    if (name.includes('lava')) return EXACT.lava;
    if (name.includes('snow')) return EXACT.snow;
    if (name.includes('ice')) return EXACT.ice;
    for (const [w, rgb] of Object.entries(WOOD).sort((a, b) => b[0].length - a[0].length))
        if (name.startsWith(w + '_')) return /(log|wood|stem|hyphae)$/.test(name) ? rgb.map(v => Math.round(v * 0.7)) : rgb;
    if (/(log|wood|stem)$/.test(name)) return [100, 75, 45];
    if (name.includes('planks') || name.includes('fence') || name.includes('door')) return [150, 115, 70];
    if (name.includes('deepslate')) return EXACT.deepslate;
    if (name.includes('sandstone')) return EXACT.sandstone;
    if (name.includes('sand')) return EXACT.sand;
    if (name.includes('grass') || name.includes('moss') || name.includes('vine') || name.includes('bush')) return [100, 150, 60];
    if (/(flower|tulip|poppy|dandelion|orchid|allium|daisy|cornflower|lily|rose|peony|lilac)/.test(name)) return [110, 160, 70];
    if (name.includes('dirt') || name.includes('mud')) return EXACT.dirt;
    if (name.includes('terracotta')) return [152, 94, 67];
    if (name.includes('brick')) return EXACT.bricks;
    if (name.includes('copper')) return [192, 107, 79];
    if (name.includes('gold')) return [246, 208, 61];
    if (name.includes('iron')) return [216, 216, 216];
    if (name.includes('quartz')) return [235, 229, 222];
    if (name.includes('ore') || name.includes('stone') || name.includes('slate') || name.includes('cobble')) return EXACT.stone;
    return [128, 128, 128];
}

/** "minecraft:oak_leaves" ya da "betterend:…" → renk. */
function colorOf(id) {
    let c = cache.get(id);
    if (!c) { c = guess(id.slice(id.indexOf(':') + 1)); cache.set(id, c); }
    return c;
}

/** Haritada görünmeyen (havayla aynı sayılan) bloklar. */
const INVISIBLE = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:barrier', 'minecraft:light',
    'minecraft:structure_void']);

module.exports = { colorOf, INVISIBLE };
