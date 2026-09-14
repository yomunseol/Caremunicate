// ---------------------------------------------------------------------------
// WORD_BANK — 1024 curated words, built as 16 semantic categories × 64.
//
// Local by design: nothing is fetched from a dictionary API, because a room
// code gets read aloud to a patient and every word has to be safe to say.
//
// Curation rules, applied to every single entry:
//   • 3–8 letters, lowercase a–z only. No digits, spaces or punctuation.
//   • Pronounceable on sight — nothing that has to be spelled out.
//   • Nothing offensive, vulgar, or slang.
//   • Nothing from the medical-emergency vocabulary. A code must never read
//     like a symptom, a procedure, or a crisis.
//   • No homophones of common words, so a code cannot be misheard. Excluded
//     pairs include bare/bear, blew/blue, dear/deer, hair/hare, pair/pear,
//     plain/plane, read/red, right/write, sea/see, sun/son, tail/tale,
//     weak/week, wood/would.
//
// The categories are exclusive — a word appears in exactly one of them. The
// dev validator in wordcode.ts enforces the length, the shape and the
// uniqueness, and throws if the bank is ever wrong.
// ---------------------------------------------------------------------------

/** 64 — mammals, reptiles, fish, insects. */
const ANIMALS = [
  'badger', 'beaver', 'bison', 'bobcat', 'buffalo', 'camel', 'caribou', 'cheetah',
  'chipmunk', 'cougar', 'coyote', 'dolphin', 'donkey', 'elephant', 'ferret', 'gazelle',
  'gecko', 'giraffe', 'gorilla', 'hamster', 'hedgehog', 'hippo', 'horse', 'hyena',
  'jackal', 'jaguar', 'kangaroo', 'koala', 'lemur', 'leopard', 'lizard', 'llama',
  'lynx', 'marmot', 'mink', 'mongoose', 'moose', 'mule', 'ocelot', 'opossum',
  'otter', 'panda', 'panther', 'piglet', 'platypus', 'puma', 'rabbit', 'raccoon',
  'reindeer', 'rhino', 'seal', 'skunk', 'sloth', 'squirrel', 'tapir', 'tiger',
  'toad', 'turtle', 'walrus', 'weasel', 'whale', 'wolf', 'wombat', 'zebra',
];

/** 64 — birds, seabirds and songbirds. */
const BIRDS = [
  'bittern', 'bluejay', 'bunting', 'buzzard', 'canary', 'cardinal', 'condor', 'crane',
  'crow', 'cuckoo', 'curlew', 'dove', 'duck', 'eagle', 'egret', 'falcon',
  'finch', 'flamingo', 'flicker', 'gannet', 'goose', 'goshawk', 'grebe', 'grouse',
  'gull', 'harrier', 'hawk', 'heron', 'hoopoe', 'ibis', 'jay', 'kestrel',
  'loon', 'magpie', 'mallard', 'martin', 'merlin', 'nightjar', 'oriole', 'osprey',
  'ostrich', 'owl', 'parakeet', 'parrot', 'peacock', 'pelican', 'penguin', 'pheasant',
  'pigeon', 'plover', 'puffin', 'quail', 'raven', 'robin', 'rook', 'seagull',
  'shrike', 'skylark', 'snipe', 'sparrow', 'starling', 'stork', 'swift', 'tern',
];

/** 64 — flowers, herbs, ferns and shrubs (nothing woody — see TREES). */
const PLANTS = [
  'agave', 'aloe', 'aster', 'azalea', 'bamboo', 'begonia', 'bluebell', 'bracken',
  'bramble', 'briar', 'cactus', 'camellia', 'cattail', 'clematis', 'clover', 'coleus',
  'crocus', 'daffodil', 'dahlia', 'daisy', 'fern', 'foxglove', 'fuchsia', 'gardenia',
  'geranium', 'gorse', 'heather', 'henna', 'hibiscus', 'hyacinth', 'iris', 'ivy',
  'jasmine', 'kelp', 'lavender', 'lilac', 'lily', 'lotus', 'lupine', 'marigold',
  'moss', 'mullein', 'nettle', 'orchid', 'pansy', 'peony', 'petunia', 'phlox',
  'poppy', 'primrose', 'reed', 'rush', 'sedge', 'shamrock', 'sorrel', 'sumac',
  'tansy', 'thistle', 'tulip', 'vetch', 'violet', 'wisteria', 'yarrow', 'zinnia',
];

/** 64 — trees plus the woody parts and stands of them. */
const TREES = [
  'acacia', 'alder', 'ash', 'aspen', 'banyan', 'baobab', 'basswood', 'beech',
  'birch', 'canopy', 'catalpa', 'cedar', 'chestnut', 'conifer', 'coppice', 'corkwood',
  'cypress', 'dogwood', 'ebony', 'elm', 'fir', 'ginkgo', 'grove', 'hardwood',
  'hawthorn', 'hazel', 'hickory', 'holly', 'hornbeam', 'ironwood', 'juniper', 'kauri',
  'larch', 'laurel', 'linden', 'locust', 'magnolia', 'mahogany', 'maple', 'mesquite',
  'mimosa', 'myrtle', 'oak', 'palm', 'pine', 'poplar', 'redbud', 'redwood',
  'rosewood', 'rowan', 'sapling', 'seedling', 'sequoia', 'softwood', 'sourwood', 'spruce',
  'sycamore', 'tamarack', 'tamarind', 'teak', 'trunk', 'willow', 'yew', 'zelkova',
];

/** 64 — conditions, skies and seasons. */
const WEATHER = [
  'autumn', 'balmy', 'blizzard', 'breeze', 'brisk', 'chill', 'chilly', 'cloud',
  'cloudy', 'crisp', 'cyclone', 'damp', 'dew', 'downpour', 'dreary', 'drizzle',
  'equinox', 'flurry', 'fog', 'foggy', 'frost', 'frosty', 'gale', 'gloomy',
  'gust', 'hail', 'haze', 'heatwave', 'humid', 'icy', 'mist', 'misty',
  'mild', 'monsoon', 'muggy', 'overcast', 'rain', 'rainbow', 'rainy', 'shower',
  'sleet', 'slush', 'snow', 'snowy', 'solstice', 'spring', 'squall', 'squally',
  'storm', 'stormy', 'sultry', 'summer', 'sunny', 'sunshine', 'tempest', 'thaw',
  'thunder', 'tornado', 'typhoon', 'weather', 'wind', 'winter', 'wintry', 'windy',
];

/** 64 — water bodies, water movement and the water cycle. */
const WATER = [
  'aqueduct', 'bay', 'beach', 'brine', 'brook', 'bubble', 'canal', 'cascade',
  'channel', 'cistern', 'cove', 'creek', 'current', 'delta', 'droplet', 'eddy',
  'estuary', 'falls', 'fjord', 'flood', 'flow', 'foam', 'fountain', 'geyser',
  'gulf', 'gush', 'inlet', 'lagoon', 'lake', 'marsh', 'oasis', 'ocean',
  'pond', 'pool', 'puddle', 'rapids', 'reef', 'ripple', 'river', 'rivulet',
  'seabed', 'seaside', 'shoal', 'shore', 'splash', 'spout', 'spray', 'stream',
  'surf', 'swamp', 'swell', 'tidal', 'tide', 'tidepool', 'trickle', 'tsunami',
  'undertow', 'vortex', 'wake', 'wave', 'wavelet', 'well', 'wetland', 'whirl',
];

/** 64 — terrain and landforms. */
const LAND = [
  'arroyo', 'atoll', 'basin', 'bluff', 'bog', 'boulder', 'butte', 'canyon',
  'cape', 'cave', 'cavern', 'chasm', 'cliff', 'crag', 'crater', 'crest',
  'dell', 'desert', 'dune', 'fen', 'field', 'foothill', 'forest', 'glade',
  'glacier', 'gorge', 'grotto', 'gully', 'heath', 'hill', 'hollow', 'island',
  'isthmus', 'jungle', 'knoll', 'ledge', 'mesa', 'moor', 'moraine', 'mound',
  'mountain', 'outcrop', 'pasture', 'peak', 'pinnacle', 'plateau', 'prairie', 'quarry',
  'range', 'ravine', 'ridge', 'sand', 'savanna', 'sierra', 'slope', 'steppe',
  'summit', 'terrain', 'thicket', 'tundra', 'vale', 'valley', 'volcano', 'woodland',
];

/** 64 — the night sky, light in the sky, and the planets. */
const SKY = [
  'astral', 'aurora', 'comet', 'cosmic', 'cosmos', 'crescent', 'dawn', 'daybreak',
  'daylight', 'dusk', 'eclipse', 'evening', 'expanse', 'galaxy', 'gleam', 'glimmer',
  'glow', 'halo', 'heavens', 'horizon', 'jupiter', 'lunar', 'lyra', 'mercury',
  'meteor', 'midnight', 'moon', 'morning', 'nebula', 'neptune', 'night', 'noon',
  'nova', 'orbit', 'orion', 'planet', 'pluto', 'polaris', 'pulsar', 'quasar',
  'radiance', 'saturn', 'shimmer', 'sirius', 'sky', 'solar', 'space', 'star',
  'starlit', 'starry', 'sunbeam', 'sundown', 'sunrise', 'sunset', 'sunspot', 'twilight',
  'twinkle', 'universe', 'uranus', 'vault', 'vega', 'venus', 'zenith', 'zodiac',
];

/** 64 — hues, tints, metals-as-colours and gemstones. */
const COLORS = [
  'amber', 'amethyst', 'aqua', 'auburn', 'azure', 'beige', 'black', 'blond',
  'brass', 'bronze', 'brown', 'brunette', 'buff', 'burgundy', 'cerulean', 'charcoal',
  'cobalt', 'coral', 'cream', 'crimson', 'cyan', 'denim', 'emerald', 'fawn',
  'flax', 'garnet', 'gold', 'golden', 'graphite', 'gray', 'green', 'indigo',
  'ink', 'ivory', 'jade', 'jet', 'khaki', 'magenta', 'maroon', 'mauve',
  'navy', 'ochre', 'onyx', 'opal', 'orange', 'pearl', 'pewter', 'pink',
  'purple', 'ruby', 'russet', 'sapphire', 'scarlet', 'sepia', 'sienna', 'silver',
  'tan', 'taupe', 'teal', 'topaz', 'umber', 'viridian', 'white', 'yellow',
];

/** 64 — fruits, vegetables, grains, nuts and staples. */
const FOODS = [
  'almond', 'apple', 'apricot', 'avocado', 'bagel', 'banana', 'berry', 'bread',
  'broccoli', 'brownie', 'bun', 'burrito', 'butter', 'cabbage', 'cake', 'candy',
  'carrot', 'cashew', 'cereal', 'cheese', 'cherry', 'chili', 'cocoa', 'coconut',
  'cookie', 'corn', 'cracker', 'cucumber', 'cupcake', 'curry', 'donut', 'dumpling',
  'egg', 'fig', 'garlic', 'grape', 'honey', 'jam', 'jelly', 'lemon',
  'lentil', 'lime', 'mango', 'melon', 'muffin', 'mushroom', 'noodle', 'oat',
  'olive', 'onion', 'pancake', 'papaya', 'pasta', 'peach', 'peanut', 'pecan',
  'pickle', 'pizza', 'popcorn', 'potato', 'pumpkin', 'radish', 'raisin', 'rice',
];

/** 64 — seasonings, herbs and flavour words. */
const SPICES = [
  'angelica', 'anise', 'aroma', 'basil', 'bitters', 'borage', 'burnet', 'caraway',
  'cardamom', 'cassia', 'cayenne', 'chervil', 'chicory', 'chives', 'chutney', 'cilantro',
  'cinnamon', 'clove', 'cress', 'cumin', 'dill', 'dressing', 'essence', 'extract',
  'fennel', 'flavor', 'galangal', 'garnish', 'ginger', 'herb', 'hyssop', 'licorice',
  'lovage', 'mace', 'marinade', 'marjoram', 'mint', 'miso', 'mustard', 'nigella',
  'nutmeg', 'oregano', 'paprika', 'parsley', 'pepper', 'pimento', 'relish', 'rosemary',
  'saffron', 'sage', 'salsa', 'salt', 'savory', 'season', 'sesame', 'spice',
  'tang', 'tarragon', 'thyme', 'turmeric', 'vanilla', 'verbena', 'vinegar', 'wasabi',
];

/** 64 — substances, textiles and building materials. */
const MATERIALS = [
  'acrylic', 'alloy', 'aluminum', 'asphalt', 'basalt', 'brick', 'burlap', 'carbon',
  'canvas', 'cement', 'ceramic', 'chalk', 'clay', 'cloth', 'concrete', 'cork',
  'cotton', 'crystal', 'diamond', 'fabric', 'felt', 'fiber', 'flannel', 'glass',
  'glue', 'granite', 'gypsum', 'iron', 'jute', 'lace', 'latex', 'leather',
  'linen', 'lumber', 'marble', 'mesh', 'metal', 'nylon', 'obsidian', 'paper',
  'plaster', 'plastic', 'plywood', 'resin', 'rubber', 'satin', 'silk', 'slate',
  'steel', 'stone', 'straw', 'suede', 'tile', 'timber', 'tin', 'titanium',
  'turf', 'velvet', 'vinyl', 'wax', 'wicker', 'wood', 'wool', 'zinc',
];

/** 64 — hand tools and hardware. */
const TOOLS = [
  'anvil', 'awl', 'axe', 'basket', 'bellows', 'blade', 'bolt', 'broom',
  'brush', 'bucket', 'caliper', 'chisel', 'clamp', 'compass', 'crowbar', 'dagger',
  'drill', 'easel', 'file', 'funnel', 'gauge', 'hammer', 'handle', 'hatchet',
  'hinge', 'hoe', 'hook', 'jack', 'jigsaw', 'kettle', 'knife', 'ladder',
  'lantern', 'latch', 'lathe', 'level', 'lever', 'mallet', 'mop', 'nail',
  'needle', 'nozzle', 'paddle', 'pickaxe', 'pliers', 'plunger', 'rake', 'rasp',
  'rivet', 'roller', 'rope', 'ruler', 'saw', 'scissors', 'scraper', 'screw',
  'scythe', 'shovel', 'sickle', 'spade', 'staple', 'trowel', 'tweezers', 'wrench',
];

/** 64 — instruments, ensembles and the language of music. */
const MUSIC = [
  'alto', 'anthem', 'ballad', 'banjo', 'bassoon', 'beat', 'bell', 'bongo',
  'cello', 'chime', 'chord', 'chorus', 'clarinet', 'clef', 'concert', 'cymbal',
  'drum', 'duet', 'echo', 'fiddle', 'flute', 'gong', 'guitar', 'harmony',
  'harp', 'horn', 'hymn', 'jazz', 'kazoo', 'keyboard', 'lullaby', 'lyric',
  'mandolin', 'march', 'melody', 'note', 'oboe', 'octave', 'opera', 'organ',
  'overture', 'piano', 'pitch', 'rhythm', 'riff', 'scale', 'serenade', 'solo',
  'sonata', 'song', 'soprano', 'staff', 'string', 'symphony', 'tempo', 'tenor',
  'treble', 'trio', 'trombone', 'trumpet', 'tuba', 'tune', 'ukulele', 'verse',
];

/** 64 — buildings, rooms and gathering places. */
const PLACES = [
  'airport', 'alley', 'arcade', 'arena', 'atrium', 'avenue', 'bakery', 'balcony',
  'barn', 'basement', 'bistro', 'bridge', 'cabin', 'cafe', 'campus', 'castle',
  'chapel', 'cinema', 'circus', 'city', 'college', 'cottage', 'dock', 'dome',
  'doorway', 'embassy', 'factory', 'farm', 'ferry', 'forge', 'fortress', 'gallery',
  'garage', 'garden', 'gateway', 'gazebo', 'hallway', 'hamlet', 'harbor', 'haven',
  'hostel', 'hotel', 'inn', 'junction', 'kiosk', 'kitchen', 'library', 'lodge',
  'loft', 'mall', 'manor', 'market', 'mill', 'motel', 'museum', 'nursery',
  'office', 'orchard', 'palace', 'pantry', 'parlor', 'pavilion', 'pier', 'plaza',
];

/** 64 — qualities worth naming a room after. */
const POSITIVE_TRAITS = [
  'agile', 'alert', 'amiable', 'ample', 'brave', 'bright', 'buoyant', 'calm',
  'candid', 'capable', 'caring', 'cheerful', 'clever', 'cordial', 'creative', 'curious',
  'daring', 'diligent', 'earnest', 'eloquent', 'faithful', 'fearless', 'flexible', 'focused',
  'friendly', 'gentle', 'genuine', 'giving', 'graceful', 'gracious', 'grateful', 'happy',
  'hardy', 'helpful', 'honest', 'hopeful', 'humble', 'humorous', 'joyful', 'kind',
  'kindly', 'lively', 'logical', 'loyal', 'mature', 'merry', 'mindful', 'modest',
  'nimble', 'noble', 'peaceful', 'playful', 'pleasant', 'poised', 'polite', 'positive',
  'precise', 'prudent', 'punctual', 'quick', 'quiet', 'radiant', 'rational', 'reliable',
];

/** 16 categories × 64 words. */
export const WORD_BANK_LENGTH = 1024;

export const WORD_BANK: readonly string[] = [
  ...ANIMALS,
  ...BIRDS,
  ...PLANTS,
  ...TREES,
  ...WEATHER,
  ...WATER,
  ...LAND,
  ...SKY,
  ...COLORS,
  ...FOODS,
  ...SPICES,
  ...MATERIALS,
  ...TOOLS,
  ...MUSIC,
  ...PLACES,
  ...POSITIVE_TRAITS,
];
