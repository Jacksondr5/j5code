# PR #24 — Thread A2A card treatment

Live UI evidence captured from an isolated, disposable T3 instance at commit `1e9e4787d438bf4b4b8e3851d704c67e30b6f7f7`.

- Viewport: 1200 × 919 CSS pixels
- `cards-clamped.png`: collapsed A2A cards; the clamp control reads `› 2 more lines`.
- `cards-expanded.png`: the same card expanded; the control reads `⌄ Collapse`.

The capture shows sent cards for awaiting-reply, measured-reply, and neutral states; received plain and expects-reply cards; directional `To`/`From` labels; and truthful absent badges. No exchange quote/link is displayed: that remains the recorded #128/#129 gap.

See `manifest.json` for capture metadata and `SHA256SUMS` for integrity verification.
