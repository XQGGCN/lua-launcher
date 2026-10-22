/** Approximate top-down colours for Minecraft blocks (original palette, not game assets). */
type RGB = readonly [number, number, number]

const exact: Record<string, RGB> = {
  grass_block: [112, 156, 72], short_grass: [104, 150, 66], grass: [104, 150, 66], tall_grass: [104, 150, 66], fern: [96, 142, 64], large_fern: [96, 142, 64],
  dirt: [134, 96, 67], coarse_dirt: [119, 85, 59], rooted_dirt: [144, 103, 76], podzol: [122, 88, 46], mycelium: [111, 99, 105], farmland: [143, 102, 70], dirt_path: [148, 122, 65], grass_path: [148, 122, 65], mud: [60, 57, 60], muddy_mangrove_roots: [70, 58, 45],
  stone: [125, 125, 125], cobblestone: [118, 118, 118], mossy_cobblestone: [101, 121, 89], granite: [149, 103, 85], diorite: [188, 188, 188], andesite: [136, 136, 137],
  deepslate: [80, 80, 82], cobbled_deepslate: [77, 77, 80], tuff: [108, 109, 102], calcite: [223, 224, 220], dripstone_block: [134, 107, 92], bedrock: [85, 85, 85],
  gravel: [131, 127, 126], sand: [219, 207, 163], red_sand: [190, 102, 33], sandstone: [216, 203, 155], red_sandstone: [186, 99, 29], clay: [160, 166, 179], suspicious_sand: [217, 204, 159],
  water: [52, 95, 218], bubble_column: [52, 95, 218], lava: [207, 92, 20], ice: [145, 183, 253], packed_ice: [141, 180, 250], blue_ice: [116, 167, 253], frosted_ice: [140, 181, 252],
  snow: [248, 254, 254], snow_block: [248, 254, 254], powder_snow: [248, 253, 253],
  oak_leaves: [72, 122, 40], spruce_leaves: [58, 94, 58], birch_leaves: [102, 138, 70], jungle_leaves: [62, 130, 30], acacia_leaves: [88, 120, 34], dark_oak_leaves: [58, 104, 30],
  mangrove_leaves: [72, 120, 36], cherry_leaves: [229, 172, 196], azalea_leaves: [92, 118, 46], flowering_azalea_leaves: [110, 120, 70], pale_oak_leaves: [128, 134, 120],
  cactus: [85, 127, 43], sugar_cane: [148, 192, 101], bamboo: [93, 145, 34], vine: [62, 108, 30], lily_pad: [32, 128, 48], kelp: [70, 120, 40], seagrass: [52, 110, 60], tall_seagrass: [52, 110, 60],
  pumpkin: [198, 118, 24], melon: [111, 145, 30], hay_block: [166, 136, 38], moss_block: [89, 109, 45], moss_carpet: [89, 109, 45], sculk: [12, 30, 36],
  netherrack: [97, 38, 38], nether_bricks: [44, 22, 26], soul_sand: [81, 62, 50], soul_soil: [75, 57, 46], basalt: [80, 81, 86], blackstone: [42, 36, 41], glowstone: [171, 131, 84],
  crimson_nylium: [130, 31, 31], warped_nylium: [43, 114, 101], crimson_stem: [92, 25, 29], warped_stem: [58, 58, 77], nether_wart_block: [114, 2, 2], warped_wart_block: [22, 119, 121], magma_block: [142, 63, 31], shroomlight: [240, 146, 70],
  end_stone: [219, 222, 158], end_stone_bricks: [218, 224, 162], obsidian: [15, 10, 24], crying_obsidian: [32, 10, 60], purpur_block: [169, 125, 169], chorus_plant: [93, 57, 93], chorus_flower: [151, 120, 151],
  glass: [175, 213, 219], tinted_glass: [44, 38, 46], torch: [255, 210, 80], lantern: [255, 200, 90], campfire: [140, 90, 40], brown_mushroom_block: [149, 111, 81], red_mushroom_block: [200, 46, 45], mushroom_stem: [203, 196, 185],
  bricks: [150, 97, 83], stone_bricks: [122, 121, 122], mossy_stone_bricks: [115, 121, 105], smooth_stone: [158, 158, 158], quartz_block: [235, 229, 222], prismarine: [99, 156, 151], dark_prismarine: [51, 91, 75], sea_lantern: [172, 199, 190],
  terracotta: [152, 94, 67], bookshelf: [117, 94, 60], crafting_table: [119, 88, 55], chest: [161, 116, 52], furnace: [110, 110, 110], tnt: [176, 50, 42], rail: [125, 110, 85], beacon: [117, 220, 215],
  coal_ore: [105, 105, 105], iron_ore: [135, 130, 126], gold_ore: [143, 140, 125], diamond_ore: [121, 141, 140], amethyst_block: [133, 97, 191], budding_amethyst: [132, 96, 186],
  dandelion: [210, 200, 30], poppy: [200, 40, 30], sweet_berry_bush: [60, 90, 40], dead_bush: [107, 79, 40], cobweb: [228, 233, 234], scaffolding: [170, 132, 73], end_rod: [220, 220, 210],
  mangrove_roots: [74, 59, 38], pointed_dripstone: [129, 102, 89], big_dripleaf: [112, 141, 46], small_dripleaf: [92, 125, 42], glow_lichen: [112, 130, 120], hanging_roots: [161, 115, 91],
}
const dyes: Record<string, RGB> = {
  white: [233, 236, 236], orange: [240, 118, 19], magenta: [189, 68, 179], light_blue: [58, 175, 217], yellow: [248, 197, 39], lime: [112, 185, 25], pink: [237, 141, 172], gray: [62, 68, 71],
  light_gray: [142, 142, 134], cyan: [21, 137, 145], purple: [121, 42, 172], blue: [53, 57, 157], brown: [114, 71, 40], green: [84, 109, 27], red: [160, 39, 34], black: [20, 21, 25],
}
const woods: Record<string, RGB> = {
  oak: [162, 130, 78], spruce: [114, 84, 48], birch: [192, 175, 121], jungle: [160, 115, 80], acacia: [168, 90, 50], dark_oak: [66, 43, 20], mangrove: [117, 54, 48],
  cherry: [226, 178, 172], bamboo: [193, 173, 80], crimson: [101, 48, 70], warped: [43, 104, 99], pale_oak: [227, 217, 214],
}

const cache = new Map<string, RGB | null>()
const TRANSPARENT = new Set(['air', 'cave_air', 'void_air', 'barrier', 'light', 'structure_void'])

export function blockColor(name: string): RGB | null {
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  const id = name.startsWith('minecraft:') ? name.slice(10) : name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
  let color: RGB | null
  if (TRANSPARENT.has(id)) color = null
  else if (exact[id]) color = exact[id]
  else color = guess(id)
  cache.set(name, color)
  return color
}

function guess(id: string): RGB {
  for (const [dye, rgb] of Object.entries(dyes).sort((a, b) => b[0].length - a[0].length)) {
    if (id.startsWith(`${dye}_`) && /(wool|carpet|concrete|terracotta|glass|bed|banner|candle|shulker_box|glazed)/.test(id)) return id.includes('terracotta') && !id.includes('glazed') ? mix(rgb, [152, 94, 67], 0.45) : rgb
  }
  for (const [wood, rgb] of Object.entries(woods).sort((a, b) => b[0].length - a[0].length)) {
    if (id.startsWith(`${wood}_`) || id.startsWith(`stripped_${wood}_`)) {
      if (/_leaves$/.test(id)) return [72, 122, 40]
      if (/_(log|wood|stem|hyphae)$/.test(id) && !id.startsWith('stripped_')) return mix(rgb, [70, 50, 30], 0.35)
      return rgb
    }
  }
  if (id.includes('leaves')) return [72, 122, 40]
  if (/_ore$/.test(id)) return id.startsWith('deepslate') ? [86, 86, 90] : [125, 125, 125]
  if (id.includes('deepslate')) return [80, 80, 82]
  if (id.includes('copper')) return id.includes('oxidized') ? [82, 162, 132] : id.includes('weathered') ? [108, 153, 110] : id.includes('exposed') ? [161, 125, 103] : [192, 107, 79]
  if (id.includes('sandstone')) return id.startsWith('red') ? [186, 99, 29] : [216, 203, 155]
  if (id.includes('prismarine')) return [99, 156, 151]
  if (id.includes('quartz')) return [235, 229, 222]
  if (id.includes('nether_brick')) return [44, 22, 26]
  if (id.includes('blackstone')) return [42, 36, 41]
  if (id.includes('purpur')) return [169, 125, 169]
  if (id.includes('brick')) return [122, 121, 122]
  if (id.includes('stone') || id.includes('andesite') || id.includes('diorite') || id.includes('granite') || id.includes('cobble')) return [125, 125, 125]
  if (id.includes('coral')) return [200, 90, 140]
  if (/(tulip|orchid|allium|bluet|daisy|cornflower|lily|rose|peony|lilac|sunflower|flower)/.test(id)) return [140, 160, 70]
  if (/(sapling|bush|grass|fern|roots|sprouts|vines|plant)/.test(id)) return [96, 142, 64]
  if (id.includes('ice')) return [145, 183, 253]
  if (id.includes('snow')) return [248, 254, 254]
  if (id.includes('glass')) return [175, 213, 219]
  if (id.includes('sand')) return [219, 207, 163]
  if (id.includes('iron')) return [200, 200, 200]
  if (id.includes('gold')) return [246, 208, 61]
  if (id.includes('diamond')) return [98, 237, 228]
  if (id.includes('emerald')) return [42, 203, 87]
  if (id.includes('redstone')) return [175, 24, 5]
  if (id.includes('lapis')) return [30, 67, 140]
  return [130, 125, 115]
}
function mix(a: RGB, b: RGB, amount: number): RGB {
  return [Math.round(a[0] * (1 - amount) + b[0] * amount), Math.round(a[1] * (1 - amount) + b[1] * amount), Math.round(a[2] * (1 - amount) + b[2] * amount)]
}
export const isWater = (name: string) => /(^|:)(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(name)

/** Pre-1.13 numeric block IDs (common ones only). */
const legacy: Record<number, string> = {
  1: 'stone', 2: 'grass_block', 3: 'dirt', 4: 'cobblestone', 5: 'oak_planks', 7: 'bedrock', 8: 'water', 9: 'water', 10: 'lava', 11: 'lava', 12: 'sand', 13: 'gravel',
  14: 'gold_ore', 15: 'iron_ore', 16: 'coal_ore', 17: 'oak_log', 18: 'oak_leaves', 20: 'glass', 24: 'sandstone', 31: 'short_grass', 32: 'dead_bush', 35: 'white_wool', 37: 'dandelion', 38: 'poppy',
  43: 'smooth_stone', 44: 'smooth_stone', 45: 'bricks', 48: 'mossy_cobblestone', 49: 'obsidian', 50: 'torch', 53: 'oak_planks', 54: 'chest', 58: 'crafting_table', 60: 'farmland', 78: 'snow', 79: 'ice', 80: 'snow_block',
  81: 'cactus', 82: 'clay', 83: 'sugar_cane', 86: 'pumpkin', 87: 'netherrack', 88: 'soul_sand', 89: 'glowstone', 98: 'stone_bricks', 99: 'brown_mushroom_block', 100: 'red_mushroom_block', 103: 'melon',
  106: 'vine', 110: 'mycelium', 111: 'lily_pad', 112: 'nether_bricks', 121: 'end_stone', 155: 'quartz_block', 159: 'terracotta', 161: 'acacia_leaves', 162: 'acacia_log', 172: 'terracotta', 174: 'packed_ice', 175: 'sunflower',
  2001: 'short_grass',
}
export const legacyBlockName = (id: number) => legacy[id] ?? (id === 0 ? 'air' : 'stone')
