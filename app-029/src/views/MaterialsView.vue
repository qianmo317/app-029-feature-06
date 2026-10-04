<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import SheetDiagram from '../components/SheetDiagram.vue'
import { findFont } from '../logic/fontLoader'
import { alignLabel } from '../logic/layout'
import {
  acrylicPieces,
  assertBomSum,
  buildBom,
  compareMaterials,
  isRemnantSheetId,
  REMNANT_PREFIX,
  yuan,
  type BomResult
} from '../logic/materials'
import { bomGroupLabel, exportProcessCardCsv } from '../logic/quote'
import {
  addRemnants,
  deleteRemnant,
  getProject,
  loadRemnants,
  newRemnantId,
  replaceRemnant,
  saveProject,
  updateRemnant
} from '../logic/store'
import {
  annotateFreeRegions,
  consumeRemnant,
  evaluateRemnant,
  pieceFitsRemnant,
  registerRemnants,
  remnantPricePerM2,
  type Remnant
} from '../logic/remnants'
import { nestPieces, type NestingResult, type Piece } from '../logic/nesting'
import { useSession } from '../logic/useSession'
import type { Project } from '../logic/types'

const route = useRoute()
const loaded = ref<Project | null>(getProject(String(route.params.id)))
const session = useSession(loaded)
const project = computed(() => loaded.value)
const layout = session.layout
const preset = session.preset
const ack = ref(false)
const remnants = ref<Remnant[]>(loadRemnants())
const registerMsg = ref('')
const consumeMsg = ref('')

const minShort = computed(() => preset.value.process.remnantMinShortMm ?? 100)

function kerfOf(r: Remnant): number {
  return preset.value.acrylicSheets.find((s) => s.id === r.sheetId)?.kerfMm ?? 3
}

/** 当前开料板材对应的整板规格（选余料时取余料来源整板） */
const sourceSheet = computed(() => {
  const sid = project.value?.sheetId ?? ''
  if (isRemnantSheetId(sid)) {
    const r = remnants.value.find((x) => x.id === sid.slice(REMNANT_PREFIX.length))
    if (r) return preset.value.acrylicSheets.find((s) => s.id === r.sheetId) ?? preset.value.acrylicSheets[0]
  }
  return preset.value.acrylicSheets.find((s) => s.id === sid) ?? preset.value.acrylicSheets[0]
})

/** 整板拼版结果（登记余料/画图标注用），带可登记与废料区域标注 */
const fullNestAnnotated = computed(() => {
  if (!layout.value || !sourceSheet.value) return null
  const sheet = sourceSheet.value
  const res = nestPieces(acrylicPieces(layout.value.chars), sheet.wMm, sheet.hMm, sheet.kerfMm, true)
  return annotateFreeRegions(res, sheet.kerfMm, minShort.value)
})

const bom = computed<BomResult | null>(() =>
  project.value && layout.value
    ? buildBom(project.value, layout.value, preset.value, { acknowledgeThinStroke: ack.value, remnants: remnants.value })
    : null
)

/** 画图用拼版：整板用带标注的整板结果；余料模式给余料结果补上空余区域标注 */
const displayNesting = computed<NestingResult | null>(() => {
  const b = bom.value
  if (!b) return null
  if (b.board.kind === 'remnant') {
    const copy: NestingResult = {
      ...b.nesting,
      sheets: b.nesting.sheets.map((s) => ({ ...s, pieces: [...s.pieces], shelves: [...s.shelves], freeRegions: [] }))
    }
    return annotateFreeRegions(copy, b.sheet.kerfMm, minShort.value)
  }
  return fullNestAnnotated.value
})

const diagramW = computed(() => (bom.value?.board.kind === 'remnant' ? bom.value.board.remnant.wMm : bom.value?.sheet.wMm ?? 0))
const diagramH = computed(() => (bom.value?.board.kind === 'remnant' ? bom.value.board.remnant.hMm : bom.value?.sheet.hMm ?? 0))

const sumCheck = computed(() => (bom.value ? assertBomSum(bom.value) : null))
const compare = computed(() =>
  project.value && layout.value && bom.value ? compareMaterials(project.value, layout.value, preset.value, bom.value) : []
)

const grouped = computed(() => {
  const b = bom.value
  if (!b) return []
  const map = new Map<string, { label: string; rows: typeof b.materials }>()
  for (const m of b.materials) {
    const label = bomGroupLabel(m.kind)
    const hit = map.get(m.kind) ?? { label, rows: [] }
    hit.rows.push(m)
    map.set(m.kind, hit)
  }
  return [...map.values()]
})

const allAvailableRemnants = computed(() => remnants.value.filter((r) => r.status === 'available'))
const usedUpRemnants = computed(() => remnants.value.filter((r) => r.status === 'used_up'))

/** 当前本批料件（用于余料能否裁下的预判定） */
const batchPieces = computed<Piece[]>(() => (layout.value ? acrylicPieces(layout.value.chars) : []))

/** 每块余料对本批料件的试排判定（选它时按锯缝后实际尺寸判定，含转 90°） */
const remnantEvals = computed(() => {
  const map = new Map<string, ReturnType<typeof evaluateRemnant>>()
  for (const r of allAvailableRemnants.value) {
    map.set(r.id, evaluateRemnant(batchPieces.value, r, kerfOf(r), true))
  }
  return map
})

const selectedRemnant = computed(() => {
  const sid = project.value?.sheetId ?? ''
  if (!isRemnantSheetId(sid)) return null
  return remnants.value.find((r) => r.id === sid.slice(REMNANT_PREFIX.length)) ?? null
})

/** 裁得下才让选：本批所有料件按锯缝后实际尺寸（含转 90°）都放得进该余料 */
function remnantFitsAll(r: Remnant): boolean {
  return batchPieces.value.every((p) => pieceFitsRemnant(p, r, kerfOf(r), true))
}

function evalOf(r: Remnant) {
  return remnantEvals.value.get(r.id)
}

function applySheet(id: string): void {
  if (!project.value) return
  project.value.sheetId = id
  saveProject(project.value)
  consumeMsg.value = ''
}

/** 登记当前整板拼版每张板上够用的边角；同一块料重复登记认出跳过 */
function registerOffcuts(): void {
  if (!project.value || !fullNestAnnotated.value || !sourceSheet.value) return
  const sheet = sourceSheet.value
  const res = registerRemnants(
    fullNestAnnotated.value,
    remnants.value,
    {
      sheetId: sheet.id,
      sheetSpec: sheet.spec,
      thicknessMm: sheet.thicknessMm,
      sheetWMm: sheet.wMm,
      sheetHMm: sheet.hMm,
      kerfMm: sheet.kerfMm,
      minShortMm: minShort.value,
      sourcePriceCents: sheet.priceCents,
      projectId: project.value.id,
      projectName: project.value.name
    },
    newRemnantId
  )
  if (res.added.length > 0) remnants.value = addRemnants(res.added)
  registerMsg.value =
    `登记 ${res.added.length} 块余料（${res.added.map((r) => `${r.wMm}×${r.hMm}`).join('、') || '无'}）；` +
    `同一块料重复登记认出跳过 ${res.skipped.length} 块；` +
    `另有 ${res.scraps.length} 处太窄太碎（短边 < ${minShort.value}mm）已在拼版图标为废料、不登记。`
}

/** 确认按当前拼版开料：用掉选中余料，按用掉区域扣减或标已用完 */
function consumeSelectedRemnant(): void {
  if (!project.value || !bom.value || !selectedRemnant.value) return
  const r = selectedRemnant.value
  if (bom.value.nesting.unplaced.length > 0 || bom.value.nesting.oversize.length > 0) {
    consumeMsg.value = '当前余料裁不下全部料件，未扣减；请换板或调整料件。'
    return
  }
  const result = consumeRemnant(
    r,
    bom.value.nesting,
    { kerfMm: kerfOf(r), minShortMm: minShort.value, projectName: project.value.name },
    newRemnantId
  )
  remnants.value = replaceRemnant(r.id, result.next)
  const kept = result.next.filter((x) => x.status === 'available')
  consumeMsg.value =
    kept.length > 0
      ? `已按用掉区域扣减，剩余 ${kept.length} 块余料（${kept.map((x) => `${x.wMm}×${x.hMm}`).join('、')}）已登记回库存；原块注销。`
      : '该余料已用完，标记为已用完，不能再选。'
  // 开料完成后回到来源整板口径，便于继续登记/开料
  project.value.sheetId = r.sheetId
  saveProject(project.value)
}

function markUsedUp(r: Remnant): void {
  remnants.value = updateRemnant({ ...r, status: 'used_up' })
}

function restoreRemnant(r: Remnant): void {
  remnants.value = updateRemnant({ ...r, status: 'available' })
}

function removeRemnantRow(r: Remnant): void {
  remnants.value = deleteRemnant(r.id)
  if (project.value?.sheetId === REMNANT_PREFIX + r.id) {
    project.value.sheetId = r.sheetId
    saveProject(project.value)
  }
}

function processCard(): void {
  if (project.value && layout.value && bom.value) {
    exportProcessCardCsv(project.value, layout.value, bom.value, findFont(project.value.layout.settings.fontId)?.family ?? '')
  }
}

function fmtArea(r: Remnant): string {
  return ((r.wMm * r.hMm) / 1e6).toFixed(3)
}
</script>

<template>
  <div class="page">
    <div v-if="!project" class="card">
      <h1>项目不存在</h1>
      <router-link to="/">返回项目列表</router-link>
    </div>

    <template v-else>
      <div v-if="bom?.blocked" class="banner bad">
        <b>工艺风险拦截：</b>
        <ul class="notes" style="color: inherit">
          <li v-for="(r, i) in bom.blockReasons" :key="i">{{ r }}</li>
        </ul>
        <button
          v-if="!bom.nesting.oversize.length && !bom.nesting.unplaced.length && !selectedRemnant"
          class="primary"
          style="margin-top: 6px"
          @click="ack = true"
        >
          已确认工艺风险，继续出报价
        </button>
        <span class="muted" style="margin-left: 8px">未确认前不出报价单（避免做不出来的活）</span>
      </div>

      <div class="split">
        <section class="card">
          <header>
            <h1>材料清单</h1>
            <span class="hint">{{ project.name }}</span>
          </header>

          <div class="field">
            <label>面板材料方案</label>
            <div class="ctl">
              <select v-model="project.panelMaterialId">
                <option v-for="m in preset.panelMaterials" :key="m.id" :value="m.id">{{ m.name }}</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>亚克力板材规格（整板或余料）</label>
            <div class="ctl">
              <select :value="project.sheetId" @change="applySheet(($event.target as HTMLSelectElement).value)">
                <optgroup label="整板（按整张计价）">
                  <option v-for="s in preset.acrylicSheets" :key="s.id" :value="s.id">{{ s.spec }}</option>
                </optgroup>
                <optgroup v-if="allAvailableRemnants.length" label="登记余料（按用掉面积计价，锯缝后实际尺寸判定）">
                  <option
                    v-for="r in allAvailableRemnants"
                    :key="r.id"
                    :value="REMNANT_PREFIX + r.id"
                    :disabled="!remnantFitsAll(r)"
                  >
                    余料 {{ r.wMm }}×{{ r.hMm }}mm · {{ fmtArea(r) }}㎡ · 来自「{{ r.fromProjectName }}」{{
                      remnantFitsAll(r) ? '（本批裁得下）' : '（本批有件裁不下，不可选）'
                    }}
                  </option>
                </optgroup>
              </select>
            </div>
          </div>
          <p class="muted" v-if="selectedRemnant" style="margin: -4px 0 8px">
            选中余料：来自项目「{{ selectedRemnant.fromProjectName }}」第 {{ selectedRemnant.fromSheetIndex + 1 }} 张板，
            板上位置 ({{ selectedRemnant.xOnSheet }}, {{ selectedRemnant.yOnSheet }})，可用
            {{ selectedRemnant.wMm }}×{{ selectedRemnant.hMm }}mm。
            判定口径：料件 + 1 条锯缝（{{ kerfOf(selectedRemnant) }}mm）≤ 余料，
            可转 90° 摆；以锯缝后的实际尺寸为准。
          </p>
          <div v-if="selectedRemnant && evalOf(selectedRemnant)" class="banner" style="margin-bottom: 8px">
            <b>这块料够切：</b>
            <span v-if="evalOf(selectedRemnant)!.fit.length">
              {{ evalOf(selectedRemnant)!.fit.map((p) => p.label).join('、') }}（共 {{ evalOf(selectedRemnant)!.fit.length }} 件）
            </span>
            <span v-else>无</span>
            <b v-if="evalOf(selectedRemnant)!.cant.length" style="color: var(--danger)">
              ；裁不下：{{ evalOf(selectedRemnant)!.cant.map((p) => `${p.label} ${p.wMm}×${p.hMm}`).join('、') }}
            </b>
          </div>

          <h3 style="margin-top: 12px">材料用量要点</h3>
          <div class="kv-list">
            <span class="muted">异形字口径</span><span>按外接矩形（每个连通域一件），不用轮廓面积</span>
            <span class="muted">拼版方式</span><span>分层装箱（guillotine，料条横向贯通）</span>
            <span class="muted">料件总数</span><span class="mono">{{ bom?.nesting.pieceCount ?? 0 }} 件</span>
            <span class="muted">料件面积</span><span class="mono">{{ bom?.pieceAreaM2.toFixed(3) ?? 0 }} ㎡</span>
            <span class="muted">开料板材</span>
            <span class="mono">
              <template v-if="bom?.board.kind === 'remnant'">
                余料 1 块（{{ bom.board.remnant.wMm }}×{{ bom.board.remnant.hMm }}mm），用掉
                {{ bom.board.usedAreaM2.toFixed(3) }}㎡
              </template>
              <template v-else>{{ bom?.nesting.sheetCount ?? 0 }} 张整板</template>
            </span>
            <span class="muted">面板材料金额</span>
            <span class="mono">¥{{ bom ? yuan(bom.acrylicCents) : '0.00' }}<template v-if="bom?.board.kind === 'remnant'">（按用掉面积摊分，非整张板）</template></span>
            <span class="muted">综合利用率</span>
            <span class="mono">{{ bom ? (bom.nesting.utilization * 100).toFixed(1) : 0 }}%</span>
            <span class="muted">排版摘要</span>
            <span>
              {{ layout?.sizeMm }}mm · {{ alignLabel(project.layout.settings.align) }} · 占宽 {{ layout?.occupiedW }}mm · 视觉间距极差
              {{ layout?.gapSpread }}mm
            </span>
          </div>

          <div class="row" style="margin-top: 12px">
            <button @click="registerOffcuts" :disabled="isRemnantSheetId(project.sheetId)">登记本单拼版余料</button>
            <button
              v-if="selectedRemnant"
              class="primary"
              :disabled="!!bom?.blocked"
              @click="consumeSelectedRemnant"
            >
              确认开料并扣减余料
            </button>
          </div>
          <p class="muted" v-if="registerMsg" style="margin-top: 6px">{{ registerMsg }}</p>
          <p class="muted" v-if="consumeMsg" style="margin-top: 6px">{{ consumeMsg }}</p>
          <p class="muted" v-if="isRemnantSheetId(project.sheetId)">当前选中余料，登记余料功能针对整板拼版；切回整板规格即可登记。</p>

          <div class="row" style="margin-top: 8px">
            <button @click="processCard">导出工艺卡（CSV）</button>
            <router-link :to="`/quote/${project.id}`"><button class="primary">去报价单</button></router-link>
          </div>
          <p class="muted" v-if="bom?.nesting.oversize.length">
            超板料件：{{ bom.nesting.oversize.map((p) => `${p.label} ${p.wMm}×${p.hMm}`).join('；') }}（需换更大板材或分件拼接）
          </p>
        </section>

        <section>
          <div class="card">
            <header>
              <h2>材料明细与金额</h2>
              <span class="hint">金额单位「分」，Σ 明细 = 合计</span>
            </header>
            <table>
              <thead>
                <tr>
                  <th>类别</th>
                  <th>规格 / 说明</th>
                  <th class="num">数量</th>
                  <th>单位</th>
                  <th class="num">单价（元）</th>
                  <th class="num">金额（元）</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="g in grouped" :key="g.label">
                  <tr v-for="(m, i) in g.rows" :key="`${g.label}${i}`">
                    <td>{{ i === 0 ? g.label : '' }}</td>
                    <td>{{ m.spec }}</td>
                    <td class="num">{{ m.qty }}</td>
                    <td>{{ m.unit }}</td>
                    <td class="num">{{ yuan(m.unitPriceCents) }}</td>
                    <td class="num">{{ yuan(m.amountCents) }}</td>
                  </tr>
                </template>
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="5">合计</td>
                  <td class="num">{{ bom ? yuan(bom.totalCents) : '0.00' }}</td>
                </tr>
              </tfoot>
            </table>
            <p class="muted">{{ sumCheck?.message }}</p>
            <p class="muted" v-if="bom?.board.kind === 'remnant'">
              本单面板用余料开出：{{ bom.board.remnant.wMm }}×{{ bom.board.remnant.hMm }}mm 的余料上用掉
              {{ bom.board.usedAreaM2.toFixed(3) }}㎡，按原整板 {{ bom.board.sheet.spec }} 单价
              ¥{{ yuan(bom.board.sheet.priceCents) }}/张摊分（¥{{ yuan(remnantPricePerM2(bom.board.remnant)) }}/㎡），
              仅计 <b>¥{{ yuan(bom.board.costCents) }}</b>，不按整张板计。
            </p>
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>余料库存（本机存储，下次打开自动读回）</h2>
              <span class="hint">短边 ≥ {{ minShort }}mm 才登记；共 {{ remnants.length }} 块，可用 {{ allAvailableRemnants.length }}，已用完 {{ usedUpRemnants.length }}</span>
            </header>
            <table v-if="remnants.length">
              <thead>
                <tr>
                  <th>规格来源</th>
                  <th class="num">可用尺寸 mm</th>
                  <th class="num">面积 ㎡</th>
                  <th>来源 / 板上位置</th>
                  <th>状态</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in remnants" :key="r.id" :class="{ 'row-active': selectedRemnant?.id === r.id }">
                  <td class="muted" style="font-size: 12px">{{ r.sheetSpec }}</td>
                  <td class="num mono">{{ r.wMm }}×{{ r.hMm }}</td>
                  <td class="num">{{ fmtArea(r) }}</td>
                  <td class="muted" style="font-size: 12px">
                    「{{ r.fromProjectName }}」第 {{ r.fromSheetIndex + 1 }} 张板<br />
                    位置 ({{ r.xOnSheet }}, {{ r.yOnSheet }}) / 原板 {{ r.originWMm }}×{{ r.originHMm }}
                  </td>
                  <td>
                    <span class="tag" :class="r.status === 'available' ? 'ok' : 'bad'">
                      {{ r.status === 'available' ? '可选用' : '已用完' }}
                    </span>
                  </td>
                  <td>
                    <div class="row">
                      <button v-if="r.status === 'available'" @click="markUsedUp(r)">标用完</button>
                      <button v-else @click="restoreRemnant(r)">恢复可用</button>
                      <button class="danger" @click="removeRemnantRow(r)">删</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="muted" v-else>暂无余料。在上方对整板拼版点「登记本单拼版余料」即可把够用的边角入库。</p>
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>
                板材拼版图（{{ bom?.board.kind === 'remnant'
                  ? `${bom.board.remnant.wMm}×${bom.board.remnant.hMm}mm 余料`
                  : `${bom?.sheet.wMm}×${bom?.sheet.hMm}mm` }}）
              </h2>
              <span class="hint">细虚线为分层切割线；绿框＝可登记余料；斜纹＝废料不能再裁</span>
            </header>
            <SheetDiagram
              v-if="bom && displayNesting"
              :nesting="displayNesting"
              :sheet-w="diagramW"
              :sheet-h="diagramH"
            />
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>裁切尺寸清单</h2>
              <span class="hint">同尺寸合并计数</span>
            </header>
            <table>
              <thead>
                <tr><th>料件</th><th class="num">宽 mm</th><th class="num">高 mm</th><th class="num">数量</th></tr>
              </thead>
              <tbody>
                <tr v-for="(c, i) in bom?.cutList ?? []" :key="i">
                  <td>{{ c.label }}</td>
                  <td class="num">{{ c.wMm }}</td>
                  <td class="num">{{ c.hMm }}</td>
                  <td class="num">{{ c.count }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>多材质成本对照</h2>
              <span class="hint">同一排版结果下 5 种工艺</span>
            </header>
            <table>
              <thead>
                <tr>
                  <th>材质</th>
                  <th>说明</th>
                  <th class="num">面板</th>
                  <th class="num">LED</th>
                  <th class="num">电源</th>
                  <th class="num">配件</th>
                  <th class="num">加工</th>
                  <th class="num">合计（元）</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in compare" :key="c.id" :class="{ 'row-active': c.id === project.panelMaterialId }">
                  <td>{{ c.name }}</td>
                  <td class="muted">{{ c.desc }}</td>
                  <td class="num">{{ yuan(c.panelCents) }}</td>
                  <td class="num">{{ yuan(c.ledCents) }}</td>
                  <td class="num">{{ yuan(c.psuCents) }}</td>
                  <td class="num">{{ yuan(c.accessoryCents) }}</td>
                  <td class="num">{{ yuan(c.laborCents) }}</td>
                  <td class="num"><b>{{ yuan(c.totalCents) }}</b></td>
                </tr>
              </tbody>
            </table>
            <p class="muted">
              蓝色高亮行为<strong>当前选中方案</strong>：直接采用实际材料清单（与报价单金额一致）；其余行为按预设单价估算。非发光材质不计 LED 与电源，配件与加工按同工艺比例折算。
            </p>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>
