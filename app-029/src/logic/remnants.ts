/**
 * 余料库（本机存储，无后端）：
 * - 拼版后把整板上「够用」的边角登记为余料，记录来自哪张板、板上位置与实际长宽；
 * - 同一块料重复登记按指纹去重（来源板 + 位置 + 锯缝后实际尺寸），不记成两条；
 * - 用掉后按区域扣减（扣出的新边角另行登记）或直接标记已用完；已用完的不可再选；
 * - 数据落 localStorage，下次打开原样读回。
 */

import type { SheetSpec } from './materials'
import type { LeftoverRegion } from './nesting'

export interface Remnant {
  id: string
  /** 人读编号，如 YL-0007 */
  code: string
  /** 规格/材质说明（继承来源板） */
  spec: string
  sheetSpecId: string
  thicknessMm: number
  /** 锯缝后实际可裁尺寸（判定够不够裁以它为准） */
  wMm: number
  hMm: number
  /** 来自哪张板（板规格 + 第几张） */
  sourceSheetSpec: string
  sourceBoardLabel: string
  /** 最近一次登记它的项目名（溯源用） */
  sourceProject: string
  /** 在来源板上的位置（mm，板左上角为原点） */
  xMm: number
  yMm: number
  /** 余料链：从哪块余料裁出 */
  parentRemnantId?: string
  parentRemnantCode?: string
  status: 'available' | 'used'
  createdAt: number
  updatedAt: number
  /** 去重指纹 */
  fingerprint: string
}

export interface ConsumeOptions {
  /** true：整块按已用完处理；false：保留 children 作为新边角 */
  markUsed?: boolean
}

const KEY = 'app029.remnants.v1'

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储失败不影响当前会话
  }
}

/** 去重指纹：同一项目同一来源板同一位置同一锯缝后尺寸视为同一块料 */
export function remnantFingerprint(fp: {
  sheetSpecId: string
  boardIndex: number
  projectId: string
  x: number
  y: number
  w: number
  h: number
}): string {
  const r = (v: number): number => Math.round(v * 10) / 10
  return [fp.sheetSpecId, fp.projectId, fp.boardIndex, r(fp.x), r(fp.y), r(fp.w), r(fp.h)].join('|')
}

function newRemnantId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function nextCode(list: Remnant[]): string {
  let max = 0
  for (const r of list) {
    const m = /^YL-(\d+)$/.exec(r.code)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `YL-${String(max + 1).padStart(4, '0')}`
}

export function listRemnants(): Remnant[] {
  return readJson<Remnant[]>(KEY, [])
}

export function listAvailableRemnants(): Remnant[] {
  return listRemnants().filter((r) => r.status === 'available')
}

export function getRemnant(id: string): Remnant | null {
  return listRemnants().find((r) => r.id === id) ?? null
}

export interface RegisterInput {
  sheet: SheetSpec
  boardIndex: number
  boardsTotal: number
  projectId: string
  projectName: string
  regions: LeftoverRegion[]
}

export interface RegisterResult {
  added: Remnant[]
  duplicates: LeftoverRegion[]
}

/** 登记一张板上的可用边角；指纹已存在的不重复登记 */
export function registerLeftovers(input: RegisterInput): RegisterResult {
  const list = listRemnants()
  const existing = new Set(list.map((r) => r.fingerprint))
  const added: Remnant[] = []
  const duplicates: LeftoverRegion[] = []
  const now = Date.now()
  for (const region of input.regions) {
    const fp = remnantFingerprint({
      sheetSpecId: input.sheet.id,
      boardIndex: input.boardIndex,
      projectId: input.projectId,
      x: region.x,
      y: region.y,
      w: region.wMm,
      h: region.hMm
    })
    if (existing.has(fp)) {
      duplicates.push(region)
      continue
    }
    existing.add(fp)
    const r: Remnant = {
      id: newRemnantId(),
      code: nextCode([...list, ...added]),
      spec: `余料 ${Math.round(region.wMm)}×${Math.round(region.hMm)}mm（${input.sheet.thicknessMm}mm 厚）`,
      sheetSpecId: input.sheet.id,
      thicknessMm: input.sheet.thicknessMm,
      wMm: region.wMm,
      hMm: region.hMm,
      sourceSheetSpec: input.sheet.spec,
      sourceBoardLabel: `${input.sheet.spec} 第 ${input.boardIndex + 1}/${input.boardsTotal} 张`,
      sourceProject: input.projectName,
      xMm: region.x,
      yMm: region.y,
      status: 'available',
      createdAt: now,
      updatedAt: now,
      fingerprint: fp
    }
    added.push(r)
  }
  if (added.length > 0) writeJson(KEY, [...list, ...added])
  return { added, duplicates }
}

/** 登记从余料板上扣出的新边角（继承溯源链） */
export function registerChildLeftovers(fp: {
  parent: Remnant
  projectId: string
  projectName: string
  regions: LeftoverRegion[]
}): RegisterResult {
  const list = listRemnants()
  const existing = new Set(list.map((r) => r.fingerprint))
  const added: Remnant[] = []
  const duplicates: LeftoverRegion[] = []
  const now = Date.now()
  for (const region of fp.regions) {
    // 区域坐标是相对父余料左上角的本地坐标，换算到父料来源板的绝对坐标以保持位置可溯源
    const absX = fp.parent.xMm + region.x
    const absY = fp.parent.yMm + region.y
    const fpx = [fp.parent.sheetSpecId, fp.projectId, fp.parent.id, Math.round(absX * 10) / 10, Math.round(absY * 10) / 10, Math.round(region.wMm * 10) / 10, Math.round(region.hMm * 10) / 10].join('|')
    if (existing.has(fpx)) {
      duplicates.push(region)
      continue
    }
    existing.add(fpx)
    const r: Remnant = {
      id: newRemnantId(),
      code: nextCode([...list, ...added]),
      spec: `余料 ${Math.round(region.wMm)}×${Math.round(region.hMm)}mm（${fp.parent.thicknessMm}mm 厚）`,
      sheetSpecId: fp.parent.sheetSpecId,
      thicknessMm: fp.parent.thicknessMm,
      wMm: region.wMm,
      hMm: region.hMm,
      sourceSheetSpec: fp.parent.sourceSheetSpec,
      sourceBoardLabel: `${fp.parent.code} 扣减后边角`,
      sourceProject: fp.projectName,
      xMm: absX,
      yMm: absY,
      parentRemnantId: fp.parent.id,
      parentRemnantCode: fp.parent.code,
      status: 'available',
      createdAt: now,
      updatedAt: now,
      fingerprint: fpx
    }
    added.push(r)
  }
  if (added.length > 0) writeJson(KEY, [...list, ...added])
  return { added, duplicates }
}

/** 核销：整块标记已用完（不可再选） */
export function markRemnantUsed(id: string): Remnant | null {
  const list = listRemnants()
  const idx = list.findIndex((r) => r.id === id)
  if (idx < 0) return null
  list[idx] = { ...list[idx], status: 'used', updatedAt: Date.now() }
  writeJson(KEY, list)
  return list[idx]
}

/** 手工恢复：已用完改回可用（登记信息仍在） */
export function markRemnantAvailable(id: string): Remnant | null {
  const list = listRemnants()
  const idx = list.findIndex((r) => r.id === id)
  if (idx < 0) return null
  list[idx] = { ...list[idx], status: 'available', updatedAt: Date.now() }
  writeJson(KEY, list)
  return list[idx]
}

export function deleteRemnant(id: string): void {
  writeJson(
    KEY,
    listRemnants().filter((r) => r.id !== id)
  )
}

/** 清空已用完的余料记录（保留可用库存） */
export function purgeUsedRemnants(): number {
  const list = listRemnants()
  const next = list.filter((r) => r.status !== 'used')
  writeJson(KEY, next)
  return list.length - next.length
}
