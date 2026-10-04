/**
 * 余料（边角料）登记与再利用：
 * - 拼完板后，把板上「够大还能裁」的空余区域登记成余料；太窄太碎的只标废料不登记；
 * - 每条余料记录来源（哪张板/项目）、在板上的位置与长宽；同一块料重复登记按指纹认出，不记两条；
 * - 选余料开料时按锯缝后的实际尺寸判定裁不裁得下（含可转 90°）；用掉后按用掉区域扣减或标已用完；
 * - 余料按面积摊分原整板单价：用余料开出的部分只按用掉的那块面积算钱，不按整张板。
 *
 * 本模块只做纯逻辑；读写 localStorage 见 store.ts。
 */

import {
  extractFreeRegions,
  nestPieces,
  type FreeRegion,
  type NestingResult,
  type Piece,
  type SheetLayout
} from './nesting'

/** 余料状态：available 可选用；used_up 已用完，不许再选 */
export type RemnantStatus = 'available' | 'used_up'

export interface Remnant {
  id: string
  /** 规格/材质来源：板材规格 spec（同规格才能替用） */
  sheetSpec: string
  /** 来源板材 id */
  sheetId: string
  thicknessMm: number
  /** 来源整板尺寸（mm） */
  originWMm: number
  originHMm: number
  /** 当前可用尺寸（锯缝后实际可用，mm） */
  wMm: number
  hMm: number
  /** 在来源整板上的位置（板本地坐标，原点左上） */
  xOnSheet: number
  yOnSheet: number
  /** 来自该次拼版的第几张板（0 起） */
  fromSheetIndex: number
  /** 登记来源项目名/项目 id，便于追溯 */
  fromProjectId: string
  fromProjectName: string
  /** 原整板单价（分/张），用于按面积摊分 */
  sourcePriceCents: number
  createdAt: number
  status: RemnantStatus
  /** 来源余料 id（余料再裁切后产生的二级余料） */
  parentRemnantId?: string
  /** 溯源链：最近一次开料项目 */
  lastUsedProjectName?: string
}

/** 用于去重的指纹：来源项目 + 来源板 + 在板上位置 + 尺寸 */
export function remnantFingerprint(r: Pick<Remnant, 'fromProjectId' | 'fromSheetIndex' | 'xOnSheet' | 'yOnSheet' | 'wMm' | 'hMm'>): string {
  return [r.fromProjectId, r.fromSheetIndex, r.xOnSheet, r.yOnSheet, r.wMm, r.hMm].map((v) => String(v)).join('|')
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

export interface RegisterResult {
  added: Remnant[]
  skipped: Remnant[]
  scraps: Array<{ sheetIndex: number; region: FreeRegion }>
}

/**
 * 把一次拼版结果里每张板的可用边角登记为余料。
 * 同一块料（同项目同板同位置同尺寸）已登记则认出并跳过，不会记成两条。
 * 太窄太碎（短边 < minShortMm）的区域不登记，作为废料返回供拼版图标注。
 */
export function registerRemnants(
  result: NestingResult,
  existing: Remnant[],
  meta: {
    sheetId: string
    sheetSpec: string
    thicknessMm: number
    sheetWMm: number
    sheetHMm: number
    kerfMm: number
    minShortMm: number
    sourcePriceCents: number
    projectId: string
    projectName: string
  },
  newId: () => string
): RegisterResult {
  const known = new Set(existing.map(remnantFingerprint))
  const added: Remnant[] = []
  const skipped: Remnant[] = []
  const scraps: RegisterResult['scraps'] = []
  for (const sheet of result.sheets) {
    if (sheet.remnantId) continue // 余料板拼完不再二次自动登记（其剩余在消费时按用掉区域扣减）
    const regions = sheet.freeRegions.length > 0 ? sheet.freeRegions : extractFreeRegions(sheet, meta.kerfMm, meta.minShortMm)
    for (const region of regions) {
      if (region.kind === 'scrap') {
        scraps.push({ sheetIndex: sheet.index, region })
        continue
      }
      const draft = {
        fromProjectId: meta.projectId,
        fromProjectName: meta.projectName,
        fromSheetIndex: sheet.index,
        xOnSheet: round1(region.x),
        yOnSheet: round1(region.y),
        wMm: round1(region.wMm),
        hMm: round1(region.hMm)
      }
      const fp = remnantFingerprint(draft)
      if (known.has(fp)) {
        const hit = existing.find((r) => remnantFingerprint(r) === fp)
        if (hit) skipped.push(hit)
        continue
      }
      known.add(fp)
      added.push({
        id: newId(),
        sheetSpec: meta.sheetSpec,
        sheetId: meta.sheetId,
        thicknessMm: meta.thicknessMm,
        originWMm: meta.sheetWMm,
        originHMm: meta.sheetHMm,
        ...draft,
        sourcePriceCents: meta.sourcePriceCents,
        createdAt: Date.now(),
        status: 'available'
      })
    }
  }
  return { added, skipped, scraps }
}

/** 单件能否在余料上裁下（按锯缝后实际尺寸，允许转 90°） */
export function pieceFitsRemnant(p: Piece, r: Remnant, kerfMm: number, allowRotate = true): boolean {
  const k = Math.max(0, kerfMm)
  const direct = p.wMm + k <= r.wMm + 1e-9 && p.hMm + k <= r.hMm + 1e-9
  const turned = allowRotate && p.hMm + k <= r.wMm + 1e-9 && p.wMm + k <= r.hMm + 1e-9
  return direct || turned
}

export interface RemnantFitReport {
  remnant: Remnant
  /** 裁得下的件（含明细） */
  fit: Piece[]
  /** 裁不下的件（含锯缝后或转摆后仍超尺寸） */
  cant: Piece[]
  /** 试排版结果（1 块余料，放不下的进 unplaced） */
  nest: NestingResult
}

/**
 * 判定一批料件能否在「这一块余料」上裁下，并说明够切哪几件。
 * 判定口径：与拼版一致，按锯缝后的实际尺寸（件 + 1 条锯缝 ≤ 余料），可转 90° 摆。
 */
export function evaluateRemnant(pieces: Piece[], r: Remnant, kerfMm: number, allowRotate = true): RemnantFitReport {
  const nest = nestPieces(pieces, [{ wMm: r.wMm, hMm: r.hMm, maxSheets: 1, remnantId: r.id }], kerfMm, allowRotate)
  const fitIds = new Set<string>()
  for (const s of nest.sheets) for (const p of s.pieces) fitIds.add(p.id)
  const fit: Piece[] = []
  const cant: Piece[] = []
  for (const p of pieces) {
    if (fitIds.has(p.id)) fit.push(p)
    else cant.push(p)
  }
  return { remnant: r, fit, cant, nest }
}

/** 余料按面积摊分单价（分/㎡），四舍五入到分 */
export function remnantPricePerM2(r: Remnant): number {
  const areaM2 = (r.originWMm * r.originHMm) / 1e6
  return areaM2 > 0 ? Math.round(r.sourcePriceCents / areaM2) : 0
}

/** 某排版在余料上实际用掉的面积（㎡） */
export function usedAreaM2(nest: NestingResult): number {
  return nest.totalPieceAreaMm2 / 1e6
}

/** 该次余料开料应付金额（分）= 用掉面积 × 摊分单价，整数分 */
export function remnantCostCents(r: Remnant, nest: NestingResult): number {
  return Math.round(usedAreaM2(nest) * remnantPricePerM2(r))
}

export interface ConsumeResult {
  /** 该块余料消费后的状态：用完（标 used_up）或扣减后的新余料（最多 2 个矩形） */
  next: Remnant[]
  consumed: boolean
}

/**
 * 用掉以后按用掉的区域扣减：沿 guillotine 结果在该余料上抽空余矩形。
 * 扣减后短边仍 ≥ minShortMm 的保留为新余料（parentRemnantId 指回原块）；
 * 剩余太窄太碎或已无空余时，直接把原块标成 used_up。
 */
export function consumeRemnant(
  r: Remnant,
  nest: NestingResult,
  opts: { kerfMm: number; minShortMm: number; projectName: string },
  newId: () => string
): ConsumeResult {
  const sheet = nest.sheets.find((s) => s.remnantId === r.id) ?? nest.sheets[0]
  if (!sheet) {
    return { next: [{ ...r, status: 'used_up' as const, lastUsedProjectName: opts.projectName }], consumed: false }
  }
  const regions = extractFreeRegions(sheet as SheetLayout, opts.kerfMm, opts.minShortMm)
  const keep = regions.filter((g) => g.kind === 'usable')
  if (keep.length === 0) {
    return { next: [{ ...r, status: 'used_up' as const, lastUsedProjectName: opts.projectName }], consumed: true }
  }
  const next: Remnant[] = keep.slice(0, 2).map((g) => ({
    ...r,
    id: newId(),
    parentRemnantId: r.id,
    wMm: round1(g.wMm),
    hMm: round1(g.hMm),
    xOnSheet: round1(r.xOnSheet + g.x),
    yOnSheet: round1(r.yOnSheet + g.y),
    createdAt: Date.now(),
    status: 'available' as const,
    lastUsedProjectName: opts.projectName
  }))
  return { next, consumed: true }
}

/** 拼版图用：给整板拼版结果填上每板空余区域（可登记/废料），不改变其它字段 */
export function annotateFreeRegions(result: NestingResult, kerfMm: number, minShortMm: number): NestingResult {
  for (const s of result.sheets) {
    s.freeRegions = extractFreeRegions(s, kerfMm, minShortMm)
  }
  return result
}
