import type { HighlightArt as HighlightArtName } from "@t3tools/client-runtime/j5/highlights";
import type { CSSProperties } from "react";

// The illustration kit: the marketing site's paper boat (apps/marketing/src/components/BoatSprite.astro)
// and its palette, chart paper in the light theme and navy in the dark one. Only the tile carries
// this palette; the entry's words stay in the app's own colours. Still images only.
//
// A highlight's PR adds its scene here and names it in HighlightArt (client-runtime).

/** The art palette as custom properties, which inherit into every shape below. */
export const HIGHLIGHT_ART_PALETTE_CLASS_NAME =
  "[--eye:#12202f] [--art-bg:#f4efe4] [--art-bg2:#ebe3d1] [--art-dim:#5f6a76] [--art-sea:#3b8fae] [--hull:#fbf7ee] [--ink:#12202f] [--msg-ask:#e08a3c] [--msg-reply:#2f7d5b] [--sail-l:#e5ddc8] [--sail-r:#fbf7ee] dark:[--art-bg:#0a1c30] dark:[--art-bg2:#102a47] dark:[--art-dim:rgba(223,233,238,.6)] dark:[--hull:#f4efe4] dark:[--ink:#dfe9ee] dark:[--msg-reply:#6fcf9a] dark:[--sail-l:#cfd9df] dark:[--sail-r:#f4efe4]";

/** The paper boat, 64×44 in its own units with the pennant above y 0. An agent, wherever it appears. */
function Boat({
  x,
  y,
  scale = 1,
  pennant,
}: {
  x: number;
  y: number;
  scale?: number;
  pennant: string;
}) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <polygon
        points="14,30 32,8 32,30"
        fill="var(--sail-l)"
        stroke="var(--ink)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <polygon
        points="32,8 32,30 50,30"
        fill="var(--sail-r)"
        stroke="var(--ink)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <polygon
        points="4,30 60,30 50,44 14,44"
        fill="var(--hull)"
        stroke="var(--ink)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M8 35h48" stroke="var(--ink)" strokeOpacity="0.25" strokeWidth="1" />
      <circle cx="24" cy="37" r="1.4" fill="var(--eye)" />
      <circle cx="40" cy="37" r="1.4" fill="var(--eye)" />
      <path d="M32 8v-7" stroke="var(--ink)" strokeWidth="1.4" />
      <polygon
        points="32,0 45,3.5 32,7"
        fill={pennant}
        stroke={pennant}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </g>
  );
}

/** Two swell lines across the bottom of a 150-wide tile. */
function Sea({ y }: { y: number }) {
  const swell = (at: number) =>
    `M0 ${at} Q 15 ${at - 5} 30 ${at} T 60 ${at} T 90 ${at} T 120 ${at} T 150 ${at}`;
  return (
    <>
      <path d={swell(y)} stroke="var(--art-sea)" strokeOpacity=".5" strokeWidth="1.2" fill="none" />
      <path
        d={swell(y + 11)}
        stroke="var(--art-sea)"
        strokeOpacity=".3"
        strokeWidth="1.2"
        fill="none"
      />
    </>
  );
}

/** Peering: an agent on each of two machines, messages crossing between them. */
function PeeringScene() {
  return (
    <>
      <Sea y={104} />
      <path
        d="M36 54 Q 75 2 114 54"
        stroke="var(--art-dim)"
        strokeOpacity=".6"
        strokeWidth="1.2"
        strokeDasharray="3 5"
        fill="none"
      />
      <path
        d="M36 54 Q 75 26 114 54"
        stroke="var(--art-dim)"
        strokeOpacity=".6"
        strokeWidth="1.2"
        strokeDasharray="3 5"
        fill="none"
      />
      <Boat x={4} y={60} pennant="var(--msg-ask)" />
      <Boat x={84} y={60} pennant="var(--msg-reply)" />
      <circle cx="62" cy="20" r="4.5" fill="var(--msg-ask)" />
      <circle cx="92" cy="36" r="4.5" fill="var(--msg-reply)" />
    </>
  );
}

const SCENES: Record<HighlightArtName, () => React.ReactNode> = {
  peering: PeeringScene,
};

const TILE_STYLE: CSSProperties = {
  backgroundColor: "var(--art-bg)",
  backgroundImage: "radial-gradient(120% 90% at 80% 20%, var(--art-bg2) 0%, transparent 60%)",
};

/** The 150-wide tile at the right of an entry; the entry fades its edge into the text. */
export function HighlightArtTile({ art }: { readonly art: HighlightArtName }) {
  const Scene = SCENES[art];
  return (
    <div className={`size-full ${HIGHLIGHT_ART_PALETTE_CLASS_NAME}`} style={TILE_STYLE}>
      <svg
        aria-hidden
        className="block size-full"
        focusable="false"
        preserveAspectRatio="xMidYMid meet"
        viewBox="0 0 150 124"
      >
        <Scene />
      </svg>
    </div>
  );
}
