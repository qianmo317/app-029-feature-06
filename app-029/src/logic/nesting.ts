/**
 * 亚克力板材拼版（规格书第 8 节）：
 * - 板材按矩形切出，异形字用「外接矩形」计算，不用轮廓面积；
 * - 同一套 guillotine 思路（每层料条横向贯通、再纵向分切），重复件用分层装箱；
 * - 输出所需板数、利用率与裁切清单；单件超过板材尺寸时显式报错，不静默。
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

/** 板上空余矩形区域（坐标相对该板左上角，mm；尺寸已扣锯缝，即实际可再裁尺寸） */
export interface LeftoverRegion {
  x: number
  y: number
  wMm: number
  hMm: number
}

/** 板来源：新整板或登记余料 */
export interface BoardSource {
  kind: 'full' | 'remnant'
  remnantId?: string
  remnantCode?: string
  spec: string
}

export interface SheetLayout {
  index: number
  pieces: PlacedPiece[]
  shelves: ShelfCut[]
  usedAreaMm2: number
  sheetAreaMm2: number
  utilization: number
  /** 该板实际宽高（余料板与整板不同） */
  boardWMm?: number
  boardHMm?: number
  source?: BoardSource
  /** 可登记再用的边角余料（实际尺寸已扣锯缝） */
  leftovers?: LeftoverRegion[]
  /** 太窄太碎、不可再裁的空余区域（拼版图上需标出） */
  scraps?: LeftoverRegion[]
  /** 本板已用区域（用于余料核销时按区域扣减） */
  consumed?: LeftoverRegion[]
}

/** 作为板材候选的登记余料 */
export interface StockBoardInput {
  id: string
  code?: string
  wMm: number
  hMm: number
}

/** 一块余料板的实际耗用 */
export interface StockBoardUse {
  remnantId: string
  remnantCode?: string
  wMm: number
  hMm: number
  usedAreaMm2: number
  areaM2: number
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
  /** 实际开的新整板数（余料板不计） */
  fullSheetCount: number
  /** 选中并实际使用的余料板块数 */
  stockBoardCount: number
  utilization: number
  /** 仅按新整板计的利用率 */
  fullUtilization: number
  cutList: CutItem[]
  pieceCount: number
  totalPieceAreaMm2: number
  sheetAreaMm2: number
  /** 新整板总面积 mm²（余料板不计） */
  fullSheetAreaMm2: number
  oversize: Piece[]
  /** 各余料板的实际耗用（金额按此折算） */
  stockUses: StockBoardUse[]
  /** 选中但整块未排进任何料件的余料 */
  unusedStock: StockBoardInput[]
}

/**
 * 分层装箱（shelf / guillotine）：
 * 1) 按高度降序；2) 尽量塞进已有料层，否则开新层；3) 层高 = 该层最高件，横向贯通可一刀切到底。
 */
export function nestPieces(pieces: Piece[], sheetW: number, sheetH: number, kerfMm = 3, allowRotate = true): NestingResult {
  const kerf = Math.max(0, kerfMm)
  const oversize: Piece[] = []
  const usable = pieces.filter((p) => {
    const fits = (p.wMm + kerf <= sheetW && p.hMm + kerf <= sheetH) || (allowRotate && p.hMm + kerf <= sheetW && p.wMm + kerf <= sheetH)
    if (!fits) oversize.push(p)
    return fits
  })
  // 高度降序（高件优先，减少层数浪费）
  const sorted = [...usable].sort((a, b) => Math.max(b.wMm, b.hMm) - Math.max(a.wMm, a.hMm) || b.hMm - a.hMm)
  const sheets: SheetLayout[] = []
  interface SheetAcc {
    pieces: PlacedPiece[]
    shelves: ShelfCut[]
    cursorY: number
  }
  let current: SheetAcc | null = null

  const newSheet = (): SheetAcc => {
    const s: SheetAcc = { pieces: [], shelves: [], cursorY: 0 }
    sheets.push({
      index: sheets.length,
      pieces: s.pieces,
      shelves: s.shelves,
      usedAreaMm2: 0,
      sheetAreaMm2: sheetW * sheetH,
      utilization: 0
    })
    return s
  }

  for (const p of sorted) {
    // 先尝试在已有层内横排
    const tryOrient = (sheet: { pieces: PlacedPiece[]; shelves: ShelfCut[] }, w: number, h: number, rotated: boolean): boolean => {
      // 找到能容纳该件的料层（本层剩余宽度足够）
      for (const shelf of sheet.shelves) {
        if (h > shelf.heightMm + 1e-9) continue
        const used = shelfWidthUsed(sheet.pieces, shelf)
        if (used + w + kerf <= sheetW + 1e-9) {
          sheet.pieces.push({ id: p.id, label: p.label, x: used, y: shelf.y, wMm: w, hMm: h, rotated })
          return true
        }
      }
      return false
    }
    let placed = false
    const cur = current
    if (cur) {
      placed = tryOrient(cur, p.wMm, p.hMm, false)
      if (!placed && allowRotate) placed = tryOrient(cur, p.hMm, p.wMm, true)
      if (!placed) {
        // 开新层（层高 = 本件高度，横向贯通，可一刀切到底）
        const rotated = allowRotate && p.wMm + kerf > sheetW
        const w = rotated ? p.hMm : p.wMm
        const hh = rotated ? p.wMm : p.hMm
        if (cur.cursorY + hh + kerf <= sheetH + 1e-9) {
          const shelf: ShelfCut = { y: cur.cursorY, heightMm: hh, pieces: 0 }
          cur.shelves.push(shelf)
          cur.pieces.push({ id: p.id, label: p.label, x: 0, y: shelf.y, wMm: w, hMm: hh, rotated })
          cur.cursorY += hh + kerf
          placed = true
        }
      }
    }
    if (!placed) {
      const fresh = newSheet()
      current = fresh
      const rotated = allowRotate && p.wMm + kerf > sheetW && p.hMm + kerf <= sheetW
      const w = rotated ? p.hMm : p.wMm
      const h = rotated ? p.wMm : p.hMm
      const shelf: ShelfCut = { y: 0, heightMm: h, pieces: 0 }
      fresh.shelves.push(shelf)
      fresh.pieces.push({ id: p.id, label: p.label, x: 0, y: 0, wMm: w, hMm: h, rotated })
      fresh.cursorY = h + kerf
    }
  }

  // 统计
  let totalPieceArea = 0
  for (const s of sheets) {
    let area = 0
    for (const pp of s.pieces) {
      area += pp.wMm * pp.hMm
      const shelf = s.shelves.find((sh) => Math.abs(sh.y - pp.y) < 1e-9)
      if (shelf) shelf.pieces++
    }
    totalPieceArea += area
    s.usedAreaMm2 = area
    s.utilization = s.sheetAreaMm2 > 0 ? area / s.sheetAreaMm2 : 0
  }
  const sheetAreaTotal = sheets.length * sheetW * sheetH
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
    fullSheetCount: sheets.length,
    stockBoardCount: 0,
    utilization: sheetAreaTotal > 0 ? totalPieceArea / sheetAreaTotal : 0,
    fullUtilization: sheetAreaTotal > 0 ? totalPieceArea / sheetAreaTotal : 0,
    cutList,
    pieceCount: usable.length,
    totalPieceAreaMm2: totalPieceArea,
    sheetAreaMm2: sheetAreaTotal,
    fullSheetAreaMm2: sheetAreaTotal,
    oversize,
    stockUses: [],
    unusedStock: []
  }
}

/**
 * 判定料件能否裁入给定净尺寸的板材（含锯缝与旋转）。
 * 口径（界面必须写明）：料件占位 + 1 道锯缝（kerf）后不得超出板材实际尺寸；
 * 允许时可转 90° 摆放。即 (w+k≤W && h+k≤H) || (rot && h+k≤W && w+k≤H)。
 * 注意：用「锯缝后的实际尺寸」判定，不是毛料尺寸。
 */
export function pieceFits(piece: Piece, boardW: number, boardH: number, kerf: number, allowRotate = true): boolean {
  const k = Math.max(0, kerf)
  const direct = piece.wMm + k <= boardW + 1e-9 && piece.hMm + k <= boardH + 1e-9
  const rotated = allowRotate && piece.hMm + k <= boardW + 1e-9 && piece.wMm + k <= boardH + 1e-9
  return direct || rotated
}

/**
 * 余料开料：先把料件排进选中的登记余料，余下的再开新整板。
 * - 余料板按传入顺序逐块装箱（分层装箱同款规则），每块只排自己裁得下的件；
 * - 排不进任何余料的件再走整板 nestPieces 逻辑；
 * - 每块板（余料/整板）都产出 leftovers（可登记边角）与 scraps（碎料标记）；
 * - 超板件与整板口径一致，单列 oversize。
 */
export function nestWithStock(
  pieces: Piece[],
  sheetW: number,
  sheetH: number,
  kerfMm = 3,
  allowRotate = true,
  stock: StockBoardInput[] = [],
  sourceSpec = '',
  minSideMm = 100
): NestingResult {
  const kerf = Math.max(0, kerfMm)
  const oversize: Piece[] = []
  const usable = pieces.filter((p) => {
    if (!pieceFits(p, sheetW, sheetH, kerf, allowRotate)) {
      oversize.push(p)
      return false
    }
    return true
  })
  const sorted = [...usable].sort((a, b) => Math.max(b.wMm, b.hMm) - Math.max(a.wMm, a.hMm) || b.hMm - a.hMm)

  const boards: SheetLayout[] = []
  let remaining = [...sorted]
  const stockUses: StockBoardUse[] = []
  const unusedStock: StockBoardInput[] = []

  for (const sb of stock) {
    const board = packOneBoard(remaining, sb.wMm, sb.hMm, kerf, allowRotate, boards.length, {
      kind: 'remnant',
      remnantId: sb.id,
      remnantCode: sb.code,
      spec: sb.code ?? '余料'
    })
    const usedIds = new Set(board.pieces.map((p) => p.id))
    remaining = remaining.filter((p) => !usedIds.has(p.id))
    boards.push(board)
    if (board.pieces.length > 0) {
      const usedArea = board.usedAreaMm2
      stockUses.push({
        remnantId: sb.id,
        remnantCode: sb.code,
        wMm: sb.wMm,
        hMm: sb.hMm,
        usedAreaMm2: usedArea,
        areaM2: usedArea / 1e6
      })
    } else {
      unusedStock.push(sb)
    }
  }

  // 余下件开新整板（沿用 nestPieces 的逐件状态机，结果与其无余料时一致）
  const fullResult = nestPieces(remaining, sheetW, sheetH, kerf, allowRotate)
  const fullSheets = fullResult.sheets.map((s) => {
    const withSource: SheetLayout = {
      ...s,
      index: boards.length + s.index,
      boardWMm: sheetW,
      boardHMm: sheetH,
      source: { kind: 'full', spec: sourceSpec }
    }
    const { leftovers, scraps } = extractLeftovers(withSource, sheetW, sheetH, kerf, minSideMm)
    withSource.leftovers = leftovers
    withSource.scraps = scraps
    withSource.consumed = placedRegions(withSource)
    return withSource
  })

  // 给余料板补边角/碎料/已用区域
  for (const b of boards) {
    const { leftovers, scraps } = extractLeftovers(b, b.boardWMm ?? sb2(b, 'w'), b.boardHMm ?? sb2(b, 'h'), kerf, minSideMm)
    b.leftovers = leftovers
    b.scraps = scraps
    b.consumed = placedRegions(b)
  }

  boards.push(...fullSheets)

  const totalPieceArea = boards.reduce((s, b) => s + b.usedAreaMm2, 0)
  const totalArea = boards.reduce((s, b) => s + b.sheetAreaMm2, 0)
  const fullArea = fullSheets.length * sheetW * sheetH
  for (const [i, b] of boards.entries()) b.index = i

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
    sheets: boards,
    sheetCount: boards.length,
    fullSheetCount: fullSheets.length,
    stockBoardCount: boards.length - fullSheets.length,
    utilization: totalArea > 0 ? totalPieceArea / totalArea : 0,
    fullUtilization: fullArea > 0 ? fullSheets.reduce((s, b) => s + b.usedAreaMm2, 0) / fullArea : 0,
    cutList,
    pieceCount: usable.length,
    totalPieceAreaMm2: totalPieceArea,
    sheetAreaMm2: totalArea,
    fullSheetAreaMm2: fullArea,
    oversize,
    stockUses,
    unusedStock
  }
}

function sb2(b: SheetLayout, key: 'w' | 'h'): number {
  return key === 'w' ? b.boardWMm ?? 0 : b.boardHMm ?? 0
}

/**
 * 在单块板（整板或余料）内分层装箱：件列表就地筛选，返回已排版的板；
 * 排不进本板的件原样留在输入数组之外由调用方处理（这里通过返回值给出已放置 id）。
 */
function packOneBoard(
  allPieces: Piece[],
  boardW: number,
  boardH: number,
  kerf: number,
  allowRotate: boolean,
  index: number,
  source: BoardSource
): SheetLayout {
  const pieces: PlacedPiece[] = []
  const shelves: ShelfCut[] = []
  let cursorY = 0
  const board: SheetLayout = {
    index,
    pieces,
    shelves,
    usedAreaMm2: 0,
    sheetAreaMm2: boardW * boardH,
    utilization: 0,
    boardWMm: boardW,
    boardHMm: boardH,
    source
  }

  const tryOrient = (p: Piece, w: number, h: number, rotated: boolean): boolean => {
    for (const shelf of shelves) {
      if (h > shelf.heightMm + 1e-9) continue
      const used = shelfWidthUsed(pieces, shelf)
      if (used + w + kerf <= boardW + 1e-9) {
        pieces.push({ id: p.id, label: p.label, x: used, y: shelf.y, wMm: w, hMm: h, rotated })
        return true
      }
    }
    return false
  }

  for (const p of allPieces) {
    if (pieces.some((q) => q.id === p.id)) continue
    // 整块板都裁不下（含锯缝、含旋转）的件不排到本板
    if (!pieceFits(p, boardW, boardH, kerf, allowRotate)) continue
    let placed = tryOrient(p, p.wMm, p.hMm, false)
    if (!placed && allowRotate) placed = tryOrient(p, p.hMm, p.wMm, true)
    if (!placed) {
      const rotated = allowRotate && p.wMm + kerf > boardW
      const w = rotated ? p.hMm : p.wMm
      const hh = rotated ? p.wMm : p.hMm
      if (cursorY + hh + kerf <= boardH + 1e-9) {
        const shelf: ShelfCut = { y: cursorY, heightMm: hh, pieces: 0 }
        shelves.push(shelf)
        pieces.push({ id: p.id, label: p.label, x: 0, y: shelf.y, wMm: w, hMm: hh, rotated })
        cursorY += hh + kerf
      }
    }
  }

  let area = 0
  for (const pp of pieces) {
    area += pp.wMm * pp.hMm
    const shelf = shelves.find((sh) => Math.abs(sh.y - pp.y) < 1e-9)
    if (shelf) shelf.pieces++
  }
  board.usedAreaMm2 = area
  board.utilization = board.sheetAreaMm2 > 0 ? area / board.sheetAreaMm2 : 0
  return board
}

/** 已放置料件的外接矩形（核销用的「用掉区域」） */
export function placedRegions(board: SheetLayout): LeftoverRegion[] {
  return board.pieces.map((p) => ({ x: p.x, y: p.y, wMm: p.wMm, hMm: p.hMm }))
}

/**
 * 从 guillotine 分层结果提取空余区域：
 * - 每层右侧条带：宽 = 板宽 − 本层已用宽 − 锯缝，高 = 层高；
 * - 最后一层下方整块：高 = 板高 − cursorY（=末层底 + 锯缝），宽 = 板宽。
 * 尺寸均为「锯缝后的实际可裁尺寸」；任一边 < minSideMm 的不登记，归入碎料。
 */
export function extractLeftovers(
  board: SheetLayout,
  boardW: number,
  boardH: number,
  kerf: number,
  minSideMm = 100
): { leftovers: LeftoverRegion[]; scraps: LeftoverRegion[] } {
  const leftovers: LeftoverRegion[] = []
  const scraps: LeftoverRegion[] = []
  const put = (r: LeftoverRegion): void => {
    if (r.wMm + 1e-9 < minSideMm || r.hMm + 1e-9 < minSideMm) scraps.push(r)
    else leftovers.push(r)
  }
  for (const shelf of board.shelves) {
    const usedW = shelfWidthUsed(board.pieces, shelf)
    // 层与右边缘之间先让一道锯缝
    const x = usedW + kerf
    const w = boardW - x
    if (w > 1e-6) put({ x, y: shelf.y, wMm: w, hMm: shelf.heightMm })
  }
  // 末层底（含锯缝线）以下为整块余料/碎料
  let bottom = 0
  for (const sh of board.shelves) bottom = Math.max(bottom, sh.y + sh.heightMm)
  if (board.shelves.length > 0) bottom += kerf
  if (boardH - bottom > 1e-6) put({ x: 0, y: bottom, wMm: boardW, hMm: boardH - bottom })
  // 层间锯缝条（必然窄于 minSide，标碎料说明不能再裁）
  for (let i = 1; i < board.shelves.length; i++) {
    const prev = board.shelves[i - 1]
    const prevBottom = prev.y + prev.heightMm
    const gap = board.shelves[i].y - prevBottom
    if (gap > 1e-6) scraps.push({ x: 0, y: prevBottom, wMm: boardW, hMm: gap })
  }
  return { leftovers, scraps }
}

function shelfWidthUsed(pieces: PlacedPiece[], shelf: ShelfCut): number {
  let max = 0
  for (const p of pieces) {
    if (Math.abs(p.y - shelf.y) > 1e-9) continue
    max = Math.max(max, p.x + p.wMm)
  }
  return max
}