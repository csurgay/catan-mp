// Image assets of the 2004 applet (assets/image/*.gif|jpg): names, a cache
// of <img> elements, and a preload that resolves once every image settled.

export const ASSET_DIR = 'assets/image/';

export const RESOURCE_IMAGE = { f: 'fa', t: 'tegla', b: 'buza', j: 'juh', k: 'ko' };
export const DEVCARD_IMAGE = {
  l: 'lovag', u: 'utepito', f: 'felfedezes', m: 'monopol',
  k: 'konyvtar', t: 'templom', e: 'egyetem', p: 'piac', o: 'orszaghaz',
};

const imageCache = new Map();

/** Get (and lazily start loading) a cached <img>. `onLoad` fires once, only the first time. */
export function getImage(name, onLoad) {
  let entry = imageCache.get(name);
  if (!entry) {
    const img = new Image();
    img.src = `${ASSET_DIR}${name}.gif`;
    entry = { img, loaded: false };
    img.onload = () => { entry.loaded = true; if (entry.onLoad) entry.onLoad(); };
    img.onerror = () => { entry.loaded = false; };
    imageCache.set(name, entry);
  }
  if (onLoad && !entry.loaded) entry.onLoad = onLoad;
  return entry.img;
}

const ALL_ASSET_NAMES = [
  'erdo', 'agyag', 'gabonatabla', 'legelo', 'hegy', 'sivatag', 'tenger', 'kikoto',
  'fa', 'tegla', 'buza', 'juh', 'ko', 'hatlap', 'hatlaps',
  'lovag', 'utepito', 'felfedezes', 'monopol', 'egyetem', 'templom', 'konyvtar', 'orszaghaz', 'piac',
  'arak', 'ut', 'hadsereg',
  'pl1Icon', 'pl2Icon', 'pl3Icon', 'pl4Icon', 'pl5Icon', 'pl6Icon',
  'becserelButton', 'csereButton', 'kovetkezoButton',
  'hazCursor', 'varosCursor', 'utCursor', 'rabloCursor',
];

/** Starts loading every asset; resolves once all have loaded or failed. */
export function preloadAssets() {
  return Promise.all(ALL_ASSET_NAMES.map((name) => new Promise((resolve) => {
    const entry = imageCache.get(name);
    if (entry && entry.loaded) { resolve(); return; }
    getImage(name, resolve);
    imageCache.get(name).img.addEventListener('error', () => resolve(), { once: true });
  })));
}
