/**
 * 亚克力板材拼版（规格书第 8 节）：
 * - 板材按矩形切出，异形字用「外接矩形」计算，不用轮廓面积；
 * - 同一套 guillotine 思路（每层料条横向贯通、再纵向分切），重复件用分层装箱；
 * - 输出所需板数、利用率与裁切清单；单件超过板材尺寸时显式报错，不静默；
 * - 支持在「余料小板」上开料：传入板池（每块余料 maxSheets=1），放不进的件进 unplaced；
 * - 拼完可导出板上边角（extractFreeRegions）：能再裁的登记成余料，太窄太碎的标成废料。
 */

export interface Piece {
  id: string
  label: string
  wMm: number
  hMm: number
}

export interface PlacedPiece {
  id: string
  label: string
  x: number
  y: number
  wMm: number
  hMm: number
  rotated: boolean
}

export interface ShelfCut {
  y: number
  heightMm: number
  pieces: number
}

/** 板上空余区域（矩形，mm，板本地坐标，原点左上角） */
export interface FreeRegion {
  x: number
  y: number
  wMm: number
  hMm: number
  /** usable = 够大可登记为余料；scrap = 太窄太碎不能再裁 */
  kind: 'usable' | 'scrap'
  /** 来源位置说明（板右条/板底条/料层内碎片） */
  where: string
}

/** 可开料的板材（整板或余料小板） */
export interface NestBoard {
  wMm: number
  hMm: number
  /** 板池模式下最多开几张（默认不限）；余料板 = 1 */
  maxSheets?: number
  /** 余料板对应的余料 id（整板不填） */
  remnantId?: string
}

export interface SheetLayout {
  index: number
  pieces: PlacedPiece[]
  shelves: ShelfCut[]
  /** 本板宽高（余料板 ≠ 整板尺寸） */
  wMm: number
  hMm: number
  usedAreaMm2: number
  sheetAreaMm2: number
  utilization: number
  /** 板上空余区域（拼版时不填，由 extractFreeRegions 生成） */
  freeRegions: FreeRegion[]
  /** 余料板来源余料 id（整板不填） */
  remnantId?: string
}

export interface CutItem {
  label: string
  wMm: number
  hMm: number
  count: number
}

export interface NestingResult {
  sheets: SheetLayout[]
  sheetCount: number
  utilization: number
  cutList: CutItem[]
  pieceCount: number
  totalPieceAreaMm2: number
  sheetAreaMm2: number
  /** 超过可用板材尺寸、任何摆法（含转 90°）都裁不下的料件 */
  oversize: Piece[]
  /** 板池满后放不下的料件（余料不够裁时出现） */
  unplaced: Piece[]
}

const EPS = 1e-9

function fitRect(w: number, h: number, b: NestBoard): boolean {
  return w <= b.wMm + EPS && h <= b.hMm + EPS
}

/**
 * 分层装箱（shelf / guillotine）：
 * 1) 大边降序；2) 先塞已有料层/已有板，再开新层，最后才开新板；
 * 3) 层高 = 该层最高件，横向贯通可一刀切到底。
 *
 * 够不够裁一律按锯缝后的实际尺寸判定：件间预留 1 条锯缝，靠边不预留
 * （即 w + kerf ≤ 板宽、h + kerf ≤ 板高；转 90° 摆时两条边互换再判）。
 *
 * 板池：只给整板尺寸（无 maxSheets）时无限开新板（旧口径）；
 * 余料小板 maxSheets=1 时每块至多开 1 张，板池用尽后放不进的件进 unplaced，不会偷算新板。
 */
export function nestPieces(pieces: Piece[], boards: NestBoard[], kerfMm?: number, allowRotate?: boolean): NestingResult
export function nestPieces(pieces: Piece[], sheetW: number, sheetH: number, kerfMm?: number, allowRotate?: boolean): NestingResult
export function nestPieces(pieces: Piece[], arg2: number | NestBoard[], sheetHOrKerf?: number, kerfOrRotate?: number | boolean, maybeRotate?: boolean): NestingResult {
  let boardPool: NestBoard[]
  let kerf: number
  let allowRotate: boolean
  if (typeof arg2 === 'number') {
    boardPool = [{ wMm: arg2, hMm: sheetHOrKerf as number }]
    kerf = Math.max(0, (kerfOrRotate as number) ?? 3)
    allowRotate = maybeRotate ?? true
  } else {
    boardPool = arg2
    kerf = Math.max(0, sheetHOrKerf ?? 3)
    allowRotate = kerfOrRotate === undefined ? true : !!kerfOrRotate
  }

  const fitsBoard = (p: Piece, b: NestBoard): boolean =>
    fitRect(p.wMm + kerf, p.hMm + kerf, b) || (allowRotate && fitRect(p.hMm + kerf, p.wMm + kerf, b))
  const fitsAny = (p: Piece): boolean => boardPool.some((b) => fitsBoard(p, b))

  const oversize: Piece[] = []
  const usable = pieces.filter((p) => {
    if (!fitsAny(p)) {
      oversize.push(p)
      return false
    }
    return true
  })
  // 大边降序（大件优先，减少层数浪费）
  const sorted = [...usable].sort((a, b) => Math.max(b.wMm, b.hMm) - Math.max(a.wMm, a.hMm) || b.hMm - a.hMm)
  const sheets: SheetLayout[] = []
  const openedByBoard: number[] = []
  interface SheetAcc {
    layout: SheetLayout
    cursorY: number
    boardIdx: number
  }
  const accs: SheetAcc[] = []

  const newSheet = (boardIdx: number): SheetAcc => {
    const b = boardPool[boardIdx]
    const layout: SheetLayout = {
      index: sheets.length,
      pieces: [],
      shelves: [],
      wMm: b.wMm,
      hMm: b.hMm,
      usedAreaMm2: 0,
      sheetAreaMm2: b.wMm * b.hMm,
      utilization: 0,
      freeRegions: [],
      remnantId: b.remnantId
    }
    sheets.push(layout)
    openedByBoard[boardIdx] = (openedByBoard[boardIdx] ?? 0) + 1
    const acc: SheetAcc = { layout, cursorY: 0, boardIdx }
    accs.push(acc)
    return acc
  }

  const canOpen = (boardIdx: number): boolean => {
    const max = boardPool[boardIdx].maxSheets
    return max === undefined || (openedByBoard[boardIdx] ?? 0) < max
  }

  for (const p of sorted) {
    // 在指定板的已有料层内横排
    const tryShelf = (acc: SheetAcc, w: number, h: number, rotated: boolean): boolean => {
      const b = boardPool[acc.boardIdx]
      for (const shelf of acc.layout.shelves) {
        if (h > shelf.heightMm + EPS) continue
        const used = shelfWidthUsed(acc.layout.pieces, shelf)
        if (used + w + kerf <= b.wMm + EPS) {
          acc.layout.pieces.push({ id: p.id, label: p.label, x: used, y: shelf.y, wMm: w, hMm: h, rotated })
          return true
        }
      }
      return false
    }

    // 在指定板开新层（层高 = 本件高度，横向贯通，可一刀切到底）
    const tryNewShelf = (acc: SheetAcc, rotated: boolean): boolean => {
      const b = boardPool[acc.boardIdx]
      const w = rotated ? p.hMm : p.wMm
      const hh = rotated ? p.wMm : p.hMm
      if (acc.cursorY + hh + kerf <= b.hMm + EPS) {
        const shelf: ShelfCut = { y: acc.cursorY, heightMm: hh, pieces: 0 }
        acc.layout.shelves.push(shelf)
        acc.layout.pieces.push({ id: p.id, label: p.label, x: 0, y: shelf.y, wMm: w, hMm: hh, rotated })
        acc.cursorY += hh + kerf
        return true
      }
      return false
    }

    let placed = false

    // 1) 先尝试所有已开板：已有料层（正放→转放），再开新层
    for (const acc of accs) {
      const b = boardPool[acc.boardIdx]
      if (fitsBoard(p, b) && tryShelf(acc, p.wMm, p.hMm, false)) {
        placed = true
        break
      }
      if (allowRotate && fitsBoard({ ...p, wMm: p.hMm, hMm: p.wMm }, b) && tryShelf(acc, p.hMm, p.wMm, true)) {
        placed = true
        break
      }
      if (fitsBoard(p, b) && tryNewShelf(acc, false)) {
        placed = true
        break
      }
      if (allowRotate && fitsBoard({ ...p, wMm: p.hMm, hMm: p.wMm }, b) && tryNewShelf(acc, true)) {
        placed = true
        break
      }
    }

    // 2) 已开板放不下：按板池顺序开一张还能开、且本件放得进的新板
    if (!placed) {
      for (let bi = 0; bi < boardPool.length && !placed; bi++) {
        if (!canOpen(bi)) continue
        const b = boardPool[bi]
        const rotated = allowRotate && !fitRect(p.wMm + kerf, p.hMm + kerf, b) && fitRect(p.hMm + kerf, p.wMm + kerf, b)
        const w = rotated ? p.hMm : p.wMm
        const h = rotated ? p.wMm : p.hMm
        if (!fitRect(w + kerf, h + kerf, b)) continue
        const acc = newSheet(bi)
        const shelf: ShelfCut = { y: 0, heightMm: h, pieces: 0 }
        acc.layout.shelves.push(shelf)
        acc.layout.pieces.push({ id: p.id, label: p.label, x: 0, y: 0, wMm: w, hMm: h, rotated })
        acc.cursorY = h + kerf
        placed = true
      }
    }
  }

  // 统计
  let totalPieceArea = 0
  const placedIds = new Set<string>()
  for (const s of sheets) {
    let area = 0
    for (const pp of s.pieces) {
      area += pp.wMm * pp.hMm
      placedIds.add(pp.id)
      const shelf = s.shelves.find((sh) => Math.abs(sh.y - pp.y) < EPS)
      if (shelf) shelf.pieces++
    }
    totalPieceArea += area
    s.usedAreaMm2 = area
    s.utilization = s.sheetAreaMm2 > 0 ? area / s.sheetAreaMm2 : 0
  }
  const sheetAreaTotal = sheets.reduce((sum, s) => sum + s.sheetAreaMm2, 0)
  const unplaced = usable.filter((p) => !placedIds.has(p.id))
  const cutMap = new Map<string, CutItem>()
  for (const p of usable) {
    const key = `${p.label}|${p.wMm}x${p.hMm}`
    const hit = cutMap.get(key)
    if (hit) hit.count++
    else cutMap.set(key, { label: p.label, wMm: p.wMm, hMm: p.hMm, count: 1 })
  }
  const cutList = [...cutMap.values()].map((c) => ({ ...c }))
  cutList.sort((a, b) => b.wMm * b.hMm - a.wMm * a.hMm || a.label.localeCompare(b.label))

  return {
    sheets,
    sheetCount: sheets.length,
    utilization: sheetAreaTotal > 0 ? totalPieceArea / sheetAreaTotal : 0,
    cutList,
    pieceCount: usable.length,
    totalPieceAreaMm2: totalPieceArea,
    sheetAreaMm2: sheetAreaTotal,
    oversize,
    unplaced
  }
}

function shelfWidthUsed(pieces: PlacedPiece[], shelf: ShelfCut): number {
  let max = 0
  for (const p of pieces) {
    if (Math.abs(p.y - shelf.y) > EPS) continue
    max = Math.max(max, p.x + p.wMm)
  }
  return max
}

/**
 * 抽取一张板拼完后的空余区域（guillotine 排法，板本地坐标）：
 * - 料层右侧边条：x = 层内已用到的位置 + 锯缝，宽 = 板宽 − 已用 − 1 条锯缝（靠右不再留）；
 * - 整板底边条：y = 已开料层总高（含锯缝）+ 1 条锯缝，高 = 板高 − 该位置 − 1 条锯缝；
 * 锯缝统一按 1 条扣（两邻区之间只切一刀），靠边不扣。短边 ≥ minShortMm 记 usable 可登记，
 * 其余太窄太碎记 scrap（只在拼版图标「不能再裁」，不登记）。
 */
export function extractFreeRegions(layout: SheetLayout, kerfMm: number, minShortMm: number): FreeRegion[] {
  const kerf = Math.max(0, kerfMm)
  const regions: FreeRegion[] = []
  for (const shelf of layout.shelves) {
    const used = shelfWidthUsed(layout.pieces, shelf)
    // 料层内碎片：矮件上方到分层线的窄条（被夹在层内，不规整，一律视为废料）
    for (const p of layout.pieces) {
      if (Math.abs(p.y - shelf.y) > EPS) continue
      const gap = shelf.heightMm - p.hMm
      if (gap > EPS + kerf && p.wMm > EPS) {
        regions.push({ x: p.x, y: p.y + p.hMm + kerf, wMm: p.wMm, hMm: gap - kerf, kind: 'scrap', where: '料层内碎片（矮件上方）' })
      }
    }
    if (used <= EPS) continue
    const x = used + kerf
    const w = layout.wMm - used - kerf
    if (w <= EPS || shelf.heightMm <= EPS) continue
    const kind: FreeRegion['kind'] = Math.min(w, shelf.heightMm) + EPS >= minShortMm ? 'usable' : 'scrap'
    regions.push({ x, y: shelf.y, wMm: w, hMm: shelf.heightMm, kind, where: '料层右侧边条' })
  }
  const lastBottom = layout.shelves.reduce((m, sh) => Math.max(m, sh.y + sh.heightMm), 0)
  if (layout.shelves.length > 0) {
    const y = lastBottom + kerf
    const h = layout.hMm - lastBottom - 2 * kerf
    if (h > EPS && layout.wMm > EPS) {
      const kind: FreeRegion['kind'] = Math.min(layout.wMm, h) + EPS >= minShortMm ? 'usable' : 'scrap'
      regions.push({ x: 0, y, wMm: layout.wMm, hMm: h, kind, where: '板底边条' })
    }
  }
  return regions
}
