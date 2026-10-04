/**
 * 材料清单（BOM）与报价（规格书第 4.6 / 5 节）：
 * - 面板：异形字按「外接矩形」拆成料件（每个连通域一件），再做分层拼版；
 * - 金额一律整数「分」，Σ 明细金额 = 合计；
 * - 最细笔画低于工艺下限时「警告并可拦截」：未确认风险前不出报价单。
 */

import materialsData from '../data/materials.json'
import type { LedResult, Material, Project } from './types'
import type { LayoutResult, PlacedChar } from './layout'
import { nestPieces, type CutItem, type NestingResult, type Piece } from './nesting'
import { remnantCostCents, type Remnant } from './remnants'
import { computeLed, type PsuPreset } from './led'

export interface SheetSpec {
  id: string
  spec: string
  wMm: number
  hMm: number
  thicknessMm: number
  priceCents: number
  kerfMm: number
}

export interface LedModuleSpec {
  id: string
  spec: string
  spacingMm: number
  powerW: number
  lumen: number
  priceCents: number
  voltageV: number
}

export interface RuleSpec {
  type: 'perPieceAreaM2' | 'perChar' | 'perMeterPerimeter' | 'perPsu' | 'perModule' | 'perStrokeBlock' | 'perOutlinePerimeter'
  value: number
  minQty: number
}

export interface ConsumableSpec {
  id: string
  spec: string
  unit: string
  unitPriceCents: number
  rule: RuleSpec
}

export interface LaborSpec {
  id: string
  spec: string
  unit: string
  unitPriceCents: number
  rule: RuleSpec
}

export interface PanelMaterialSpec {
  id: string
  name: string
  desc: string
  useLed: boolean
  areaPriceCentsPerM2: number
  perimeterPriceCentsPerM: number
  charLaborCents: number
}

export interface Preset {
  version: string
  process: {
    strokeLimitMm: number
    defaultTrackRatio: number
    defaultMarginRatio: number
    defaultLineGapRatio: number
    panelFrameMm: number
    minTrackMm: number
    maxTrackMm: number
    warnTrackRatioLow: number
    warnTrackRatioHigh: number
    /** 余料登记门槛：空余区域短边 ≥ 该值才登记（mm），太窄太碎的只标废料 */
    remnantMinShortMm: number
  }
  acrylicSheets: SheetSpec[]
  ledModules: LedModuleSpec[]
  psu: PsuPreset
  consumables: ConsumableSpec[]
  labor: LaborSpec[]
  panelMaterials: PanelMaterialSpec[]
}

export const defaultPreset = materialsData as unknown as Preset

export interface BomResult {
  materials: Material[]
  totalCents: number
  led: LedResult
  nesting: NestingResult
  sheet: SheetSpec
  module: LedModuleSpec
  cutList: CutItem[]
  pieceAreaM2: number
  outlinePerimeterM: number
  /** 工艺拦截：未确认风险时不出报价 */
  blocked: boolean
  blockReasons: string[]
  panelMaterial: PanelMaterialSpec
  /** 本次开料用的板材：整板或余料 */
  board: BoardSource
  /** 面板材料金额（分）：整板按张、余料按用掉面积摊分 */
  acrylicCents: number
}

/** 开料板材来源：整板（按张计）或余料（按用掉面积摊分原板单价） */
export type BoardSource =
  | { kind: 'sheet'; sheet: SheetSpec }
  | { kind: 'remnant'; remnant: Remnant; sheet: SheetSpec; usedAreaM2: number; costCents: number }

export const REMNANT_PREFIX = 'remnant:'

export function isRemnantSheetId(sheetId: string): boolean {
  return sheetId.startsWith(REMNANT_PREFIX)
}

export function remnantIdFromSheetId(sheetId: string): string {
  return sheetId.slice(REMNANT_PREFIX.length)
}

export interface BomOptions {
  /** 已确认「最细笔画低于工艺下限」的风险 */
  acknowledgeThinStroke?: boolean
  /** 可选余料库存（project.sheetId 为 remnant:xxx 时使用，默认空） */
  remnants?: Remnant[]
}

function ruleQty(rule: RuleSpec, ctx: { areaM2: number; chars: number; perimeterM: number; psu: number; modules: number; blocks: number; outlinePerimeterM: number }): number {
  let raw = 0
  switch (rule.type) {
    case 'perPieceAreaM2':
      raw = ctx.areaM2 * rule.value
      break
    case 'perChar':
      raw = ctx.chars * rule.value
      break
    case 'perMeterPerimeter':
      raw = ctx.perimeterM * rule.value
      break
    case 'perPsu':
      raw = ctx.psu * rule.value
      break
    case 'perModule':
      raw = ctx.modules * rule.value
      break
    case 'perStrokeBlock':
      raw = ctx.blocks * rule.value
      break
    case 'perOutlinePerimeter':
      raw = ctx.outlinePerimeterM * rule.value
      break
    default:
      raw = 0
  }
  return Math.max(rule.minQty, raw)
}

/** 拆料件：每个连通域（笔画块）一件，按外接矩形计 */
export function acrylicPieces(chars: PlacedChar[]): Piece[] {
  const out: Piece[] = []
  let seq = 0
  for (const c of chars) {
    if (c.missing || c.blank || c.geom.blockBBoxes.length === 0) continue
    const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
    c.geom.blockBBoxes.forEach((b, bi) => {
      const wMm = Math.max(1, Math.ceil((b.x1 - b.x0) * k))
      const hMm = Math.max(1, Math.ceil((b.y1 - b.y0) * k))
      out.push({ id: `p${seq++}`, label: `${c.char}-${bi + 1}`, wMm, hMm })
    })
  }
  return out
}

export function buildBom(project: Project, layout: LayoutResult, preset: Preset, opts: BomOptions = {}): BomResult {
  const remnants = opts.remnants ?? []
  const usingRemnant = isRemnantSheetId(project.sheetId)
  const remnant = usingRemnant ? remnants.find((r) => r.id === remnantIdFromSheetId(project.sheetId)) : undefined
  // 余料来源规格可能与当前默认板材不同：锯缝/单价以来源板材为准；余料失效则回退其来源整板
  const sheet =
    (remnant ? preset.acrylicSheets.find((s) => s.id === remnant.sheetId) : undefined) ??
    preset.acrylicSheets.find((s) => s.id === project.sheetId) ??
    preset.acrylicSheets[0]
  const module = preset.ledModules.find((m) => m.id === project.ledModuleId) ?? preset.ledModules[0]
  const panelMaterial = preset.panelMaterials.find((m) => m.id === project.panelMaterialId) ?? preset.panelMaterials[0]
  const led = computeLed(layout.ledLengthMm, project.led, preset.psu)

  const pieces = acrylicPieces(layout.chars)

  // 余料开料：按余料实际尺寸（锯缝后）判定，一块余料只开 1 张，放不下的件不允许偷用新板
  let nesting: NestingResult
  let board: BoardSource
  // 选中的余料已用完或已被删除：不许再选，拦截提示（回退整板仅用于展示数值，不放行报价）
  const remnantInvalid = usingRemnant && !(remnant && remnant.status === 'available')
  if (usingRemnant && remnant && remnant.status === 'available') {
    nesting = nestPieces(pieces, [{ wMm: remnant.wMm, hMm: remnant.hMm, maxSheets: 1, remnantId: remnant.id }], sheet.kerfMm, true)
    board = {
      kind: 'remnant',
      remnant,
      sheet,
      usedAreaM2: nesting.totalPieceAreaMm2 / 1e6,
      costCents: remnantCostCents(remnant, nesting)
    }
  } else {
    nesting = nestPieces(pieces, sheet.wMm, sheet.hMm, sheet.kerfMm, true)
    board = { kind: 'sheet', sheet }
  }
  const pieceAreaM2 = nesting.totalPieceAreaMm2 / 1e6
  const outerPerimeterMm = layout.chars.reduce((s, c) => {
    const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
    return s + c.geom.outerPerimeter * k
  }, 0)
  const perimeterM = outerPerimeterMm / 1000
  const outlinePerimeterM =
    layout.chars.reduce((s, c) => {
      if (c.item.mode !== 'outline') return s
      const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
      return s + c.geom.outerPerimeter * k
    }, 0) / 1000
  const charCount = layout.chars.filter((c) => !c.missing && !c.blank).length

  const ctx = {
    areaM2: pieceAreaM2,
    chars: charCount,
    perimeterM,
    psu: led.psuCount,
    modules: led.modules,
    blocks: layout.chars.reduce((s, c) => s + (c.missing || c.blank ? 0 : c.geom.strokeBlocks), 0),
    outlinePerimeterM
  }

  const materials: Material[] = []
  // 1) 亚克力面板：整板按整张计；用余料开出来的部分只按用掉那块的面积摊分计，不按整张板
  let acrylicCents = 0
  if (board.kind === 'sheet') {
    acrylicCents = nesting.sheetCount * sheet.priceCents
    materials.push({
      kind: 'acrylic',
      spec: sheet.spec,
      qty: nesting.sheetCount,
      unit: '张',
      unitPriceCents: sheet.priceCents,
      amountCents: acrylicCents
    })
  } else {
    const r = board.remnant
    const areaM2 = board.usedAreaM2
    const perM2 = areaM2 > 0 ? Math.round(board.costCents / areaM2) : 0
    acrylicCents = board.costCents
    materials.push({
      kind: 'acrylic',
      spec: `${sheet.spec}｜余料开料（用掉 ${areaM2.toFixed(3)}㎡，来自 ${board.remnant.fromProjectName} 的余料 ${r.wMm}×${r.hMm}mm）`,
      qty: Math.round(areaM2 * 1000) / 1000,
      unit: '㎡',
      unitPriceCents: perM2,
      amountCents: acrylicCents
    })
  }
  // 2) LED 模组
  if (panelMaterial.useLed) {
    materials.push({
      kind: 'led_module',
      spec: module.spec,
      qty: led.modules,
      unit: '只',
      unitPriceCents: module.priceCents,
      amountCents: led.modules * module.priceCents
    })
    // 3) 电源
    const psuUnitPrice = Math.round(preset.psu.pricePerWattCents * led.psuUnitW)
    materials.push({
      kind: 'psu',
      spec: `${preset.psu.spec} ${led.psuUnitW}W`,
      qty: led.psuCount,
      unit: '台',
      unitPriceCents: psuUnitPrice,
      amountCents: led.psuCount * psuUnitPrice
    })
  }
  // 4) 胶与配件（描边条在下面按描边字数单独计）
  for (const c of preset.consumables) {
    if (c.id === 'trim') continue
    const raw = ruleQty(c.rule, ctx)
    const whole = ['支', '套', '个', '台'].includes(c.unit)
    const qty = whole ? Math.ceil(raw) : Math.round(raw * 100) / 100
    if (qty <= 0) continue
    materials.push({
      kind: 'glue',
      spec: c.spec,
      qty,
      unit: c.unit,
      unitPriceCents: c.unitPriceCents,
      amountCents: Math.round(qty * c.unitPriceCents)
    })
  }
  if (outlinePerimeterM > 0) {
    const trim = preset.consumables.find((c) => c.id === 'trim')
    if (trim) {
      const raw = ruleQty(trim.rule, ctx)
      const qty = Math.ceil(raw * 100) / 100
      materials.push({
        kind: 'glue',
        spec: trim.spec,
        qty,
        unit: trim.unit,
        unitPriceCents: trim.unitPriceCents,
        amountCents: Math.round(qty * trim.unitPriceCents)
      })
    }
  }
  // 5) 加工费
  for (const l of preset.labor) {
    if ((l.id === 'ledmount' || l.id === 'psuinstall') && !panelMaterial.useLed) continue
    const raw = ruleQty(l.rule, ctx)
    const whole = ['字', '台', '个', '套'].includes(l.unit)
    const qty = whole ? Math.ceil(raw) : Math.round(raw * 100) / 100
    if (qty <= 0) continue
    materials.push({
      kind: 'labor',
      spec: l.spec,
      qty,
      unit: l.unit,
      unitPriceCents: l.unitPriceCents,
      amountCents: Math.round(qty * l.unitPriceCents)
    })
  }

  const totalCents = materials.reduce((s, m) => s + m.amountCents, 0)
  const thin = layout.glyphs.filter((g) => !g.missing && g.minStrokeMm > 0 && g.minStrokeMm < project.layout.settings.strokeLimitMm)
  const boardName = board.kind === 'sheet' ? `${sheet.wMm}×${sheet.hMm}mm` : `余料 ${board.remnant.wMm}×${board.remnant.hMm}mm`
  const blockReasons = [
    ...thin.map((g) => `「${g.char}」最细笔画 ${g.minStrokeMm}mm < 工艺下限 ${project.layout.settings.strokeLimitMm}mm`),
    ...(remnantInvalid ? ['选中的余料已用完或已删除，不能再选，请改选整板或其它余料'] : []),
    ...nesting.oversize.map((p) => `料件「${p.label}」${p.wMm}×${p.hMm}mm 超过板材尺寸 ${boardName}（含锯缝 ${sheet.kerfMm}mm，正放与转 90° 均裁不下）`),
    ...nesting.unplaced.map((p) => `料件「${p.label}」${p.wMm}×${p.hMm}mm 在选中余料上排不下（一块余料只能开一次）`)
  ]
  const blocked =
    (blockReasons.length > 0 && !opts.acknowledgeThinStroke) ||
    nesting.oversize.length > 0 ||
    nesting.unplaced.length > 0 ||
    remnantInvalid

  return {
    materials,
    totalCents,
    led,
    nesting,
    sheet,
    module,
    cutList: nesting.cutList,
    pieceAreaM2,
    outlinePerimeterM,
    blocked,
    blockReasons,
    panelMaterial,
    board,
    acrylicCents
  }
}

/** 断言：Σ 材料金额 = 合计，且金额均为整数分 */
export function assertBomSum(bom: BomResult): { ok: boolean; message: string } {
  const sum = bom.materials.reduce((s, m) => s + m.amountCents, 0)
  const allInt = bom.materials.every((m) => Number.isInteger(m.amountCents))
  return {
    ok: sum === bom.totalCents && allInt,
    message: `Σ 明细 = ${sum} 分，合计 = ${bom.totalCents} 分；整数分校验：${allInt ? '通过' : '失败'}`
  }
}

/** 多材质成本对照（规格书第 5 节） */
export interface CompareRow {
  id: string
  name: string
  desc: string
  panelCents: number
  ledCents: number
  psuCents: number
  accessoryCents: number
  laborCents: number
  totalCents: number
}

export function compareMaterials(project: Project, layout: LayoutResult, preset: Preset, bom: BomResult): CompareRow[] {
  const pieceAreaM2 = bom.pieceAreaM2
  const perimeterM =
    layout.chars.reduce((s, c) => {
      const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
      return s + c.geom.outerPerimeter * k
    }, 0) / 1000
  const charCount = layout.chars.filter((c) => !c.missing && !c.blank).length
  const sumOf = (kind: Material['kind']): number => bom.materials.filter((m) => m.kind === kind).reduce((s, m) => s + m.amountCents, 0)
  const ledCents = sumOf('led_module')
  const psuCents = sumOf('psu')
  const accessoryCents = sumOf('glue')
  const laborTotal = sumOf('labor')

  return preset.panelMaterials.map((pm) => {
    // 当前选中方案：直接采用实际材料清单（与报价单完全一致，避免两套算法打架）
    if (pm.id === project.panelMaterialId) {
      return {
        id: pm.id,
        name: pm.name,
        desc: pm.desc,
        panelCents: sumOf('acrylic'),
        ledCents,
        psuCents,
        accessoryCents,
        laborCents: laborTotal,
        totalCents: bom.totalCents
      }
    }
    // 其它方案：按预设单价估算（不含 LED 的方案不计模组与电源）
    const panelCents = Math.round(
      pieceAreaM2 * pm.areaPriceCentsPerM2 + perimeterM * pm.perimeterPriceCentsPerM + charCount * pm.charLaborCents
    )
    const useLed = pm.useLed
    const led = useLed ? ledCents : 0
    const psu = useLed ? psuCents : 0
    const acc = useLed ? accessoryCents : Math.round(accessoryCents * 0.4)
    const labor = useLed ? laborTotal : Math.round(laborTotal * 0.55)
    return {
      id: pm.id,
      name: pm.name,
      desc: pm.desc,
      panelCents,
      ledCents: led,
      psuCents: psu,
      accessoryCents: acc,
      laborCents: labor,
      totalCents: panelCents + led + psu + acc + labor
    }
  })
}

/** 当前方案是否为「按实际材料清单」，用于界面标注 */
export function isActualRow(project: Project, row: CompareRow): boolean {
  return row.id === project.panelMaterialId
}

export function yuan(cents: number): string {
  return (cents / 100).toFixed(2)
}