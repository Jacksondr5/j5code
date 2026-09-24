const sheetUrls = import.meta.glob<string>("./assets/lpc/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

type Pose = "walk" | "idle" | "sitting";
type Crop = readonly [x: number, y: number, width: number, height: number];

// LPC Revised: native 32px tiles, 64px character cells, N/W/S/E direction rows.
// Constraints that hold across every sheet in ./assets/lpc:
// - Character cell origins are fixed; frames are never trimmed or recentred,
//   so the ground anchor is the same for every pose and direction.
// - Furniture is drawn at half scale (32px source -> 16 world units) with its
//   native aspect ratio and alpha; a large piece spans several tiles.
// - Attribution ships in ./assets/lpc/CREDITS.md and is shown in-app.
const PIECES = {
  desk: ["desk", [0, 128, 64, 64]],
  chair: ["chair", [0, 0, 32, 32]],
  chairBack: ["chair", [0, 44, 32, 36]],
  planter: ["planter", [64, 0, 32, 96]],
  copier: ["copier", [0, 0, 64, 64]],
  laptop: ["laptop", [32, 0, 32, 32]],
  coffee: ["coffee", [0, 0, 32, 32]],
} as const satisfies Record<string, readonly [string, Crop]>;

export interface OfficeSheetAssets {
  images: Map<string, HTMLImageElement>;
  characters: Map<string, HTMLCanvasElement>;
}

/** Per-agent colours applied to the shared LPC sheets. */
export interface Look {
  shirt: string;
  hair: string;
  pants: string;
}

/** Tint strength per layer: hair takes colour strongly, cloth keeps more of its shading. */
const TINTS: Partial<Record<string, [key: keyof Look, alpha: number]>> = {
  shirt: ["shirt", 0.55],
  hair: ["hair", 0.72],
  pants: ["pants", 0.5],
};

/** Composed characters per pose and look. Three poses for up to 23 agents must fit. */
const CHARACTER_CACHE_LIMIT = 128;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error(`Unable to load office asset: ${url}`)),
      { once: true },
    );
    image.src = url;
  });
}

let assetPromise: Promise<OfficeSheetAssets> | undefined;

export function loadOfficeSheets(): Promise<OfficeSheetAssets> {
  assetPromise ??= Promise.all(
    Object.entries(sheetUrls).map(async ([path, url]) => {
      const name = path.slice(path.lastIndexOf("/") + 1, -4);
      return [name, await loadImage(url)] as const;
    }),
  )
    .then((entries) => ({ images: new Map(entries), characters: new Map() }))
    .catch((error: unknown) => {
      assetPromise = undefined;
      throw error;
    });
  return assetPromise;
}

export function drawOfficePiece(
  ctx: CanvasRenderingContext2D,
  assets: OfficeSheetAssets,
  piece: keyof typeof PIECES,
  x: number,
  y: number,
) {
  const [name, [sx, sy, sw, sh]] = PIECES[piece];
  const image = assets.images.get(name);
  if (image) ctx.drawImage(image, sx, sy, sw, sh, x, y, sw / 2, sh / 2);
}

function characterAtlas(assets: OfficeSheetAssets, pose: Pose, look: Look) {
  const key = `${pose}:${look.shirt}:${look.hair}:${look.pants}`;
  const cached = assets.characters.get(key);
  if (cached) return cached;
  const body = assets.images.get(`body-${pose}`);
  if (!body) return;
  const canvas = document.createElement("canvas");
  canvas.width = body.naturalWidth;
  canvas.height = body.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  for (const part of ["body", "head", "pants", "shoes", "shirt", "hair"]) {
    const image = assets.images.get(`${part}-${pose}`);
    if (!image) continue;
    const tint = TINTS[part];
    if (tint) {
      const layer = document.createElement("canvas");
      layer.width = canvas.width;
      layer.height = canvas.height;
      const layerCtx = layer.getContext("2d");
      if (!layerCtx) continue;
      layerCtx.drawImage(image, 0, 0);
      layerCtx.globalCompositeOperation = "source-atop";
      layerCtx.globalAlpha = tint[1];
      layerCtx.fillStyle = look[tint[0]];
      layerCtx.fillRect(0, 0, layer.width, layer.height);
      ctx.drawImage(layer, 0, 0);
    } else ctx.drawImage(image, 0, 0);
  }
  if (assets.characters.size >= CHARACTER_CACHE_LIMIT) {
    for (const oldest of assets.characters.keys()) {
      assets.characters.delete(oldest);
      break;
    }
  }
  assets.characters.set(key, canvas);
  return canvas;
}

/** Drops composed characters so a closed panel does not keep tens of MB of canvases alive. */
export function releaseCharacterAtlases() {
  void assetPromise?.then((assets) => assets.characters.clear()).catch(() => undefined);
}

export function drawEmployee(
  ctx: CanvasRenderingContext2D,
  assets: OfficeSheetAssets,
  row: number,
  frame: number,
  x: number,
  y: number,
  pose: Pose,
  look: Look,
) {
  const atlas = characterAtlas(assets, pose, look);
  if (!atlas) return;
  const column = pose === "walk" ? frame % 8 : 0;
  // Keep the source cell and ground anchor fixed across every pose and frame.
  ctx.drawImage(
    atlas,
    column * 64,
    row * 64,
    64,
    64,
    Math.round(x) - 16,
    Math.round(y) - 31,
    32,
    32,
  );
}
