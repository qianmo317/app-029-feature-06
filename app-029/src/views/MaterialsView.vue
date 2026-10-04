<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import SheetDiagram from '../components/SheetDiagram.vue'
import { findFont } from '../logic/fontLoader'
import { alignLabel } from '../logic/layout'
import { assertBomSum, buildBom, compareMaterials, remnantFitPieces, yuan } from '../logic/materials'
import { bomGroupLabel, exportProcessCardCsv } from '../logic/quote'
import { getProject } from '../logic/store'
import {
  deleteRemnant,
  listRemnants,
  markRemnantAvailable,
  markRemnantUsed,
  purgeUsedRemnants,
  registerChildLeftovers,
  registerLeftovers,
  type Remnant
} from '../logic/remnants'
import { useSession } from '../logic/useSession'
import type { Project } from '../logic/types'

const route = useRoute()
const loaded = ref<Project | null>(getProject(String(route.params.id)))
const session = useSession(loaded)
const project = computed(() => loaded.value)
const layout = session.layout
const preset = session.preset
const ack = ref(false)
/** 核销方式：true=直接标已用完；false=按用掉区域扣减并登记剩余边角 */
const markUsedOnly = ref(false)
/** 库存版本号：余料库变动后刷新 */
const stockTick = ref(0)
const notice = ref('')

const allRemnants = computed<Remnant[]>(() => {
  void stockTick.value
  return listRemnants()
})
const selectedIds = computed<string[]>(() => project.value?.stockRemnantIds ?? [])
/** 当前板材规格/厚度一致的可用余料，才作为候选 */
const candidates = computed(() =>
  allRemnants.value.filter((r) => r.status === 'available' && r.sheetSpecId === (project.value?.sheetId ?? ''))
)
const selectedRemnants = computed(() =>
  selectedIds.value
    .map((id) => allRemnants.value.find((r) => r.id === id))
    .filter((r): r is Remnant => !!r && r.status === 'available' && r.sheetSpecId === (project.value?.sheetId ?? ''))
)
const bom = computed(() =>
  project.value && layout.value
    ? buildBom(project.value, layout.value, preset.value, { acknowledgeThinStroke: ack.value, stockRemnants: selectedRemnants.value })
    : null
)
const sumCheck = computed(() => (bom.value ? assertBomSum(bom.value) : null))
const compare = computed(() =>
  project.value && layout.value && bom.value ? compareMaterials(project.value, layout.value, preset.value, bom.value) : []
)

/** 每块候选余料：这批料件里哪些裁得下（按锯缝后实际尺寸，含旋转） */
const fitInfo = computed(() => {
  const b = bom.value
  const kerf = b?.sheet.kerfMm ?? 3
  const map = new Map<
    string,
    {
      fit: ReturnType<typeof remnantFitPieces>
      fitCount: number
      totalCount: number
      labels: string
    }
  >()
  for (const r of candidates.value) {
    const fit = remnantFitPieces(r, b?.cutList ?? [], kerf)
    const fitRows = fit.filter((f) => f.fits)
    map.set(r.id, {
      fit,
      fitCount: fitRows.length,
      totalCount: fit.reduce((s, f) => s + f.count, 0),
      labels: fitRows.map((f) => `${f.label}×${f.count}`).join('、')
    })
  }
  return map
})

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

function applySheet(id: string): void {
  if (project.value) {
    project.value.sheetId = id
    // 换板材规格后，不属于该规格的余料选择清空（仍保留在余料库中）
    project.value.stockRemnantIds = selectedIds.value.filter((sid) => {
      const r = allRemnants.value.find((x) => x.id === sid)
      return r && r.sheetSpecId === id
    })
    notice.value = ''
  }
}

function toggleRemnant(id: string, enabled: boolean): void {
  if (!project.value) return
  const cur = new Set(project.value.stockRemnantIds ?? [])
  if (enabled) cur.add(id)
  else cur.delete(id)
  project.value.stockRemnantIds = [...cur]
}

/** 把本次拼版每张新整板上「够用」的边角登记进余料库（指纹去重） */
function registerLeftoversNow(): void {
  const b = bom.value
  const p = project.value
  if (!b || !p) return
  const fullBoards = b.nesting.sheets.filter((s) => s.source?.kind !== 'remnant')
  let added = 0
  let dup = 0
  const detail: string[] = []
  fullBoards.forEach((s, ord) => {
    const regions = s.leftovers ?? []
    if (!regions.length) return
    const res = registerLeftovers({
      sheet: b.sheet,
      boardIndex: ord,
      boardsTotal: fullBoards.length,
      projectId: p.id,
      projectName: p.name,
      regions
    })
    added += res.added.length
    dup += res.duplicates.length
    detail.push(
      ...res.added.map((r) => `${r.code} ${Math.round(r.wMm)}×${Math.round(r.hMm)}mm，位置 (${Math.round(r.xMm)}, ${Math.round(r.yMm)})，来自${r.sourceBoardLabel}`)
    )
  })
  stockTick.value++
  if (added === 0 && dup === 0) notice.value = '本次拼版没有够尺寸的边角可登记（过窄/过碎的空余已在图上以红斜纹标为不可再裁）。'
  else notice.value = `登记余料 ${added} 块${dup ? `；识别出重复 ${dup} 块，未重复登记` : ''}。${detail.join('；')}`
}

/** 核销本次实际使用的余料板 */
function consumeStockNow(): void {
  const b = bom.value
  const p = project.value
  if (!b || !p) return
  const usedBoards = b.nesting.sheets.filter((s) => s.source?.kind === 'remnant')
  if (!usedBoards.length) {
    notice.value = '当前拼版没有使用任何余料板。'
    return
  }
  const detail: string[] = []
  for (const s of usedBoards) {
    const id = s.source?.remnantId
    const parent = id ? allRemnants.value.find((r) => r.id === id) : null
    if (!id || !parent) continue
    if (markUsedOnly.value || !(s.leftovers ?? []).length) {
      markRemnantUsed(id)
      detail.push(`${parent.code} 已标记为用完`)
    } else {
      // 按用掉区域扣减：父料核销，剩余边角登记为新余料（带溯源链）
      const res = registerChildLeftovers({ parent, projectId: p.id, projectName: p.name, regions: s.leftovers ?? [] })
      markRemnantUsed(id)
      detail.push(
        `${parent.code} 按用掉区域扣减，父料核销${res.added.length ? `，剩余边角登记为 ${res.added.map((r) => r.code).join('、')}` : ''}${
          res.duplicates.length ? `，重复边角 ${res.duplicates.length} 块未重复登记` : ''
        }`
      )
    }
  }
  project.value.stockRemnantIds = selectedIds.value.filter(
    (sid) => !usedBoards.some((s) => s.source?.remnantId === sid)
  )
  stockTick.value++
  notice.value = detail.join('；')
}

function markOneUsed(id: string): void {
  markRemnantUsed(id)
  stockTick.value++
}
function restoreRemnant(id: string): void {
  markRemnantAvailable(id)
  stockTick.value++
}
function removeRemnant(id: string): void {
  deleteRemnant(id)
  if (project.value) project.value.stockRemnantIds = selectedIds.value.filter((sid) => sid !== id)
  stockTick.value++
}
function purgeUsed(): void {
  const n = purgeUsedRemnants()
  stockTick.value++
  notice.value = n ? `已清除 ${n} 条已用完记录。` : '没有已用完记录。'
}

function processCard(): void {
  if (project.value && layout.value && bom.value) {
    exportProcessCardCsv(project.value, layout.value, bom.value, findFont(project.value.layout.settings.fontId)?.family ?? '')
  }
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
        <button class="primary" style="margin-top: 6px" @click="ack = true">已确认工艺风险，继续出报价</button>
        <span class="muted" style="margin-left: 8px">未确认前不出报价单（避免做不出来的活）</span>
      </div>
      <div v-if="notice" class="banner ok no-print">
        {{ notice }}
        <button style="margin-left: 8px" @click="notice = ''">知道了</button>
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
            <label>亚克力板材规格</label>
            <div class="ctl">
              <select :value="project.sheetId" @change="applySheet(($event.target as HTMLSelectElement).value)">
                <option v-for="s in preset.acrylicSheets" :key="s.id" :value="s.id">{{ s.spec }}</option>
              </select>
            </div>
          </div>

          <h3 style="margin-top: 12px">余料库存（可当板材选）</h3>
          <p class="muted">
            判定口径：料件占位 + 锯缝 {{ bom?.sheet.kerfMm ?? 0 }}mm 后不得超出余料<strong>锯缝后的实际尺寸</strong>，允许转 90°
            摆；以单块料件能否裁入为准。裁得下才允许勾选，勾选后优先用余料开料，不够再开新整板。
          </p>
          <div v-if="!candidates.length" class="muted">
            当前没有与 {{ bom?.sheet.spec }} 同规格同厚度的可用余料（先在下方拼版图里「登记本批边角」，或到余料库查看其它规格）。
          </div>
          <table v-else>
            <thead>
              <tr><th>选</th><th>编号</th><th class="num">实际尺寸</th><th>来源 / 本批可裁件</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in candidates" :key="r.id">
                <td>
                  <input
                    type="checkbox"
                    :checked="selectedIds.includes(r.id)"
                    :disabled="!(fitInfo.get(r.id)?.fitCount)"
                    @change="toggleRemnant(r.id, ($event.target as HTMLInputElement).checked)"
                  />
                </td>
                <td class="mono">{{ r.code }}</td>
                <td class="num mono">{{ Math.round(r.wMm) }}×{{ Math.round(r.hMm) }}</td>
                <td class="muted" style="font-size: 12px">
                  <div>{{ r.sourceBoardLabel }}（{{ r.sourceProject }}）</div>
                  <div v-if="fitInfo.get(r.id)?.fitCount" class="ok-text">
                    够切：{{ fitInfo.get(r.id)?.labels }}
                  </div>
                  <div v-else class="cell-bad">这批料件没有一件裁得下（含锯缝/旋转），不可选</div>
                </td>
              </tr>
            </tbody>
          </table>
          <p class="muted" v-if="bom?.nesting.unusedStock.length">
            已选但本批未实际排上的余料：{{ bom.nesting.unusedStock.map((s) => s.code).filter(Boolean).join('、') }}（不计费用、不核销）。
          </p>

          <h3 style="margin-top: 12px">材料用量要点</h3>
          <div class="kv-list">
            <span class="muted">异形字口径</span><span>按外接矩形（每个连通域一件），不用轮廓面积</span>
            <span class="muted">拼版方式</span><span>分层装箱（guillotine，料条横向贯通）</span>
            <span class="muted">料件总数</span><span class="mono">{{ bom?.nesting.pieceCount ?? 0 }} 件</span>
            <span class="muted">料件面积</span><span class="mono">{{ bom?.pieceAreaM2.toFixed(3) ?? 0 }} ㎡</span>
            <span class="muted">新开整板</span><span class="mono">{{ bom?.nesting.fullSheetCount ?? 0 }} 张</span>
            <span class="muted">使用余料板</span><span class="mono">{{ bom?.nesting.stockBoardCount ?? 0 }} 块</span>
            <span class="muted">综合利用率</span>
            <span class="mono">{{ bom ? (bom.nesting.utilization * 100).toFixed(1) : 0 }}%</span>
            <span class="muted">排版摘要</span>
            <span>
              {{ layout?.sizeMm }}mm · {{ alignLabel(project.layout.settings.align) }} · 占宽 {{ layout?.occupiedW }}mm · 视觉间距极差
              {{ layout?.gapSpread }}mm
            </span>
          </div>

          <div class="row" style="margin-top: 12px">
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
            <p class="muted" v-if="bom && bom.acrylic.remnantLines.length">
              <strong>余料计价口径：</strong>{{ bom.acrylic.note }}。用余料开出的部分只按用掉那块的面积算钱，不按整张板计。
            </p>
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>板材拼版图（{{ bom?.sheet.wMm }}×{{ bom?.sheet.hMm }}mm）</h2>
              <span class="hint">绿虚框＝可登记余料；红斜纹＝过窄过碎、不能再裁</span>
            </header>
            <SheetDiagram v-if="bom" :nesting="bom.nesting" :sheet-w="bom.sheet.wMm" :sheet-h="bom.sheet.hMm" />
            <p class="muted" style="margin-top: 8px">
              登记门槛：空余两边均 ≥ {{ preset.process.remnantMinSideMm }}mm 才登记；小于该值的边角不登记，已在上图红斜纹标出。
              余料尺寸均为锯缝后的实际可裁尺寸。
            </p>
            <div class="row" style="margin-top: 8px">
              <button class="primary" @click="registerLeftoversNow">登记本批新整板边角到余料库</button>
              <label class="ctl" style="gap: 6px">
                <input type="checkbox" v-model="markUsedOnly" />
                核销时直接标已用完（不勾＝按用掉区域扣减，剩余边角自动登记）
              </label>
              <button :disabled="!bom?.nesting.stockBoardCount" @click="consumeStockNow">
                核销本次已用余料（{{ bom?.nesting.stockBoardCount ?? 0 }} 块）
              </button>
            </div>
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>余料库（本机存储，下次打开仍在）</h2>
              <span class="hint">
                可用 {{ allRemnants.filter((r) => r.status === 'available').length }} 块 · 已用完
                {{ allRemnants.filter((r) => r.status === 'used').length }} 块
              </span>
            </header>
            <table v-if="allRemnants.length">
              <thead>
                <tr><th>编号</th><th>规格</th><th class="num">实际尺寸</th><th>来自哪张板 / 位置</th><th>状态</th><th></th></tr>
              </thead>
              <tbody>
                <tr v-for="r in allRemnants" :key="r.id" :class="{ 'row-used': r.status === 'used' }">
                  <td class="mono">{{ r.code }}</td>
                  <td>{{ r.spec }}</td>
                  <td class="num mono">{{ Math.round(r.wMm) }}×{{ Math.round(r.hMm) }}</td>
                  <td class="muted" style="font-size: 12px">
                    {{ r.sourceBoardLabel }}<br />板上位置 ({{ Math.round(r.xMm) }}, {{ Math.round(r.yMm) }})mm · 登记自
                    {{ r.sourceProject }}
                  </td>
                  <td>
                    <span class="tag" :class="r.status === 'available' ? 'ok' : 'bad'">
                      {{ r.status === 'available' ? '可用' : '已用完' }}
                    </span>
                  </td>
                  <td>
                    <button v-if="r.status === 'used'" @click="restoreRemnant(r.id)">恢复可用</button>
                    <button v-else @click="markOneUsed(r.id)">标用完</button>
                    <button class="danger" @click="removeRemnant(r.id)">删</button>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-else class="muted">余料库为空。完成一次拼版后点「登记本批新整板边角」即可入库。</p>
            <div class="row" style="margin-top: 8px">
              <button @click="purgeUsed">清除已用完记录</button>
            </div>
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

<style scoped>
.cell-bad {
  color: var(--danger);
  font-weight: 700;
}
.ok-text {
  color: #2f7d52;
}
.row-used {
  opacity: 0.6;
}
</style>
