/**
 * 材料清单（BOM）与报价（规格书第 4.6 / 5 节）：
 * - 面板：异形字按「外接矩形」拆成料件（每个连通域一件），再做分层拼版；
 * - 金额一律整数「分」，Σ 明细金额 = 合计；
 * - 最细笔画低于工艺下限时「警告并可拦截」：未确认风险前不出报价单。
 */

import materialsData from '../data/materials.json'
import type { LedResult, Material, Project } from './types'
import type { LayoutResult, PlacedChar } from './layout'
import { nestWithStock, pieceFits, type CutItem, type NestingResult, type Piece, type StockBoardInput } from './nesting'
import { computeLed, type PsuPreset } from './led'
import type { Remnant } from './remnants'

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
    /** 余料登记最小边长：小于该值的空余不登记，只标碎料 */
    remnantMinSideMm: number
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
  /** 亚克力板材费用拆分：整板按张、余料按实际耗用面积折算 */
  acrylic: AcrylicCost
}

/** 余料开料的费用明细：用掉那块算那块，绝不按整张板计 */
export interface RemnantCostLine {
  remnantId: string
  remnantCode: string
  spec: string
  usedAreaM2: number
  unitPriceCentsPerM2: number
  amountCents: number
}

export interface AcrylicCost {
  fullSheetCount: number
  fullSheetSpec: string
  fullSheetPriceCents: number
  fullSheetAmountCents: number
  remnantLines: RemnantCostLine[]
  remnantAmountCents: number
  totalCents: number
  /** 计价口径说明（界面/报价单照此写明） */
  note: string
}

export interface BomOptions {
  /** 已确认「最细笔画低于工艺下限」的风险 */
  acknowledgeThinStroke?: boolean
  /** 选中的登记余料（作为板材候选，按顺序先排余料再开新板） */
  stockRemnants?: Remnant[]
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
  const sheet = preset.acrylicSheets.find((s) => s.id === project.sheetId) ?? preset.acrylicSheets[0]
  const module = preset.ledModules.find((m) => m.id === project.ledModuleId) ?? preset.ledModules[0]
  const panelMaterial = preset.panelMaterials.find((m) => m.id === project.panelMaterialId) ?? preset.panelMaterials[0]
  const led = computeLed(layout.ledLengthMm, project.led, preset.psu)

  const pieces = acrylicPieces(layout.chars)
  // 选中的余料只取「可用、同板规格同厚度」，已用完/已删除的静默不参与
  const stockRemnants = (opts.stockRemnants ?? []).filter(
    (r) => r.status === 'available' && r.sheetSpecId === sheet.id && r.thicknessMm === sheet.thicknessMm
  )
  const stock: StockBoardInput[] = stockRemnants.map((r) => ({ id: r.id, code: r.code, wMm: r.wMm, hMm: r.hMm }))
  const nesting = nestWithStock(
    pieces,
    sheet.wMm,
    sheet.hMm,
    sheet.kerfMm,
    true,
    stock,
    sheet.spec,
    preset.process.remnantMinSideMm ?? 100
  )
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
  // 1) 亚克力面板：整板按张；余料只按「用掉那块的面积」折算，不按整张板计
  const acrylic = buildAcrylicCost(sheet, nesting)
  if (acrylic.fullSheetCount > 0) {
    materials.push({
      kind: 'acrylic',
      spec: `${sheet.spec}（新整板）`,
      qty: acrylic.fullSheetCount,
      unit: '张',
      unitPriceCents: sheet.priceCents,
      amountCents: acrylic.fullSheetAmountCents
    })
  }
  for (const line of acrylic.remnantLines) {
    materials.push({
      kind: 'acrylic',
      spec: `余料 ${line.remnantCode}（${line.spec}）按实际耗用 ${line.usedAreaM2.toFixed(4)}㎡ 计`,
      qty: Number(line.usedAreaM2.toFixed(4)),
      unit: '㎡',
      unitPriceCents: line.unitPriceCentsPerM2,
      amountCents: line.amountCents
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
  const blockReasons = [
    ...thin.map((g) => `「${g.char}」最细笔画 ${g.minStrokeMm}mm < 工艺下限 ${project.layout.settings.strokeLimitMm}mm`),
    ...nesting.oversize.map((p) => `料件「${p.label}」${p.wMm}×${p.hMm}mm 超过板材尺寸 ${sheet.wMm}×${sheet.hMm}mm`)
  ]
  const blocked = (blockReasons.length > 0 && !opts.acknowledgeThinStroke) || nesting.oversize.length > 0

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
    acrylic
  }
}

/**
 * 亚克力板材费用：
 * - 新开整板：按张 × 板单价；
 * - 选中余料：单价 = 来源板单价 ÷ 板面积（分/㎡），金额 = 该单价 × 本块实际耗用面积（料件外接矩形），
 *   即「用掉的那块算钱」，绝不按整张板计；金额取整数分。
 */
export function buildAcrylicCost(sheet: SheetSpec, nesting: NestingResult): AcrylicCost {
  const sheetAreaM2 = (sheet.wMm * sheet.hMm) / 1e6
  const pricePerM2 = sheetAreaM2 > 0 ? Math.round(sheet.priceCents / sheetAreaM2) : 0
  const remnantLines: RemnantCostLine[] = nesting.stockUses.map((u) => {
    const usedAreaM2 = Math.round(u.areaM2 * 1e4) / 1e4
    return {
      remnantId: u.remnantId,
      remnantCode: u.remnantCode ?? '',
      spec: `${Math.round(u.wMm)}×${Math.round(u.hMm)}mm`,
      usedAreaM2,
      unitPriceCentsPerM2: pricePerM2,
      amountCents: Math.round(pricePerM2 * usedAreaM2)
    }
  })
  const fullSheetAmount = nesting.fullSheetCount * sheet.priceCents
  const remnantAmount = remnantLines.reduce((s, l) => s + l.amountCents, 0)
  return {
    fullSheetCount: nesting.fullSheetCount,
    fullSheetSpec: sheet.spec,
    fullSheetPriceCents: sheet.priceCents,
    fullSheetAmountCents: fullSheetAmount,
    remnantLines,
    remnantAmountCents: remnantAmount,
    totalCents: fullSheetAmount + remnantAmount,
    note:
      nesting.stockBoardCount > 0
        ? `新整板 ${nesting.fullSheetCount} 张按整张计 ¥${(fullSheetAmount / 100).toFixed(2)}；余料 ${nesting.stockBoardCount} 块只按实际耗用面积 × ${(
            pricePerM2 / 100
          ).toFixed(2)} 元/㎡ 计 ¥${(remnantAmount / 100).toFixed(2)}（不按整张板计）`
        : `新整板 ${nesting.fullSheetCount} 张按整张计 ¥${(fullSheetAmount / 100).toFixed(2)}`
  }
}

/**
 * 判定一批料件中哪些能用某块余料裁出（含锯缝、允许转 90°）。
 * 口径：按锯缝后的实际尺寸 pieceFits 判定；返回每个可裁料件（含其需要数量）。
 */
export function remnantFitPieces(
  remnant: { wMm: number; hMm: number },
  cutList: CutItem[],
  kerf: number
): Array<{ label: string; wMm: number; hMm: number; count: number; fits: boolean; reason: string }> {
  return cutList.map((c) => {
    const fits = pieceFits({ id: '', label: c.label, wMm: c.wMm, hMm: c.hMm }, remnant.wMm, remnant.hMm, kerf, true)
    const rotated = fits && c.wMm + kerf > remnant.wMm && c.hMm + kerf <= remnant.wMm
    return {
      ...c,
      fits,
      reason: fits
        ? rotated
          ? `${c.wMm}×${c.hMm}mm 转 90° 后 +锯缝${kerf}mm 可裁入 ${Math.round(remnant.wMm)}×${Math.round(remnant.hMm)}mm`
          : `${c.wMm}×${c.hMm}mm +锯缝${kerf}mm 可直接裁入 ${Math.round(remnant.wMm)}×${Math.round(remnant.hMm)}mm`
        : `${c.wMm}×${c.hMm}mm 即使转向，加锯缝${kerf}mm 后仍超出 ${Math.round(remnant.wMm)}×${Math.round(remnant.hMm)}mm，裁不下`
    }
  })
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