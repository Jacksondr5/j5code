type Tile = readonly [number, number];

export function officeLayout(width: number, height: number, agentCount: number) {
  // One desk per agent (never fewer than two, at most 22) plus one research table
  // per three desks, so research tables are a quarter of all workstations. They
  // fill the back of the same grid.
  const deskCount = Math.max(2, Math.min(22, agentCount));
  const researchCount = Math.max(1, Math.round(deskCount / 3));
  const stationCount = deskCount + researchCount;
  // Both bounds matter: a wide, short host would otherwise ask for thousands of
  // columns and a room canvas past every browser's size limit.
  const aspect = Math.min(3, Math.max(0.3, width / Math.max(height, 1)));
  let columns = Math.max(
    20,
    Math.min(56, Math.max(Math.ceil(20 * aspect), Math.round(width / 32))),
  );
  let rows = Math.max(20, Math.round(columns / aspect));
  // Grow the room until the grid holds every station: widen while allowed, then
  // deepen, so a capped width never forces an unbounded column count.
  while (Math.floor((columns - 10) / 5) * Math.floor((rows - 11) / 5) < stationCount) {
    if (columns < 56) {
      columns += 1;
      rows = Math.max(rows, Math.round(columns / aspect));
    } else rows += 1;
  }
  const maxDeskColumns = Math.max(2, Math.floor((columns - 10) / 5));
  const deskRows = Math.ceil(stationCount / maxDeskColumns);
  const deskColumns = Math.ceil(stationCount / deskRows);
  const columnSpacing = 5;
  const rowSpacing = Math.max(5, Math.min(7, Math.floor((rows - 11) / deskRows)));
  const startColumn = Math.max(4, Math.floor((columns - 8 - (deskColumns - 1) * 5) / 2));
  const startRow = Math.max(6, Math.floor((rows - 7 - (deskRows - 1) * rowSpacing) / 2));
  const stations: Tile[] = Array.from({ length: stationCount }, (_, i) => [
    startColumn + (i % deskColumns) * columnSpacing,
    startRow + Math.floor(i / deskColumns) * rowSpacing,
  ]);
  const desks = stations.slice(0, deskCount);
  const researchTables = stations.slice(deskCount);
  const bossWall = columns - 7;
  const boss: Tile = [columns - 4, 5];
  const entry: Tile = [Math.floor(columns / 2), rows - 1];
  const cafeTop = rows - 5;
  const cafeSeats = [
    { tile: [4, rows - 4] as Tile, dir: "down" as const },
    { tile: [7, rows - 4] as Tile, dir: "down" as const },
    { tile: [4, rows - 2] as Tile, dir: "up" as const },
    { tile: [7, rows - 2] as Tile, dir: "up" as const },
  ];
  const map: string[][] = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, c) =>
      c === 0 || r === 0 || c === columns - 1 || r === rows - 1 ? "#" : r === 1 ? "F" : ".",
    ),
  );
  const set = (c: number, r: number, tile: string) => {
    map[r]![c] = tile;
  };
  for (let r = 2; r < 8; r += 1) {
    for (let c = bossWall + 1; c < columns - 1; c += 1) set(c, r, "o");
  }
  for (let r = 1; r < 8; r += 1) set(bossWall, r, "#");
  for (let c = bossWall; c < columns - 1; c += 1) set(c, 8, "#");
  set(boss[0], 8, "d");
  set(boss[0] - 1, boss[1] - 1, "B");
  set(boss[0], boss[1] - 1, "B");
  for (const [c, r] of desks) {
    set(c - 1, r - 1, "D");
    set(c, r - 1, "D");
  }
  for (const [c, r] of researchTables) {
    set(c - 1, r - 1, "R");
    set(c, r - 1, "R");
  }
  for (let r = cafeTop; r < rows - 1; r += 1) {
    for (let c = 1; c < 9; c += 1) set(c, r, c === 1 ? "C" : ",");
  }
  for (const c of [3, 4, 6, 7]) set(c, rows - 3, "T");
  set(2, 1, "W");
  set(3, 1, "W");
  set(columns - 4, 10, "X");
  set(columns - 3, rows - 3, "P");
  set(2, 4, "P");
  const meeting = columns >= 28 ? ([columns - 10, rows - 4] as Tile) : null;
  if (meeting) {
    for (let c = meeting[0]; c < meeting[0] + 4; c += 1) set(c, meeting[1], "M");
  }
  set(entry[0], entry[1], "m");
  set(entry[0] + 1, entry[1], "m");
  return {
    key: `${columns}:${rows}:${stationCount}`,
    map: map.map((row) => row.join("")),
    columns,
    rows,
    desks,
    bossWall,
    boss,
    entry,
    cafeTop,
    cafeSeats,
    meeting,
    researchTables,
    clock: [columns - 4, 1] as Tile,
    windows: [Math.max(8, Math.floor(columns * 0.45)), columns - 2],
  };
}
