<script setup lang="ts">
import { computed } from 'vue'
import type { LeftoverRegion, NestingResult, SheetLayout } from '../logic/nesting'

const props = defineProps<{
  nesting: NestingResult
  sheetW: number
  sheetH: number
  active?: number
}>()

const sheets = computed<SheetLayout[]>(() => props.nesting.sheets)
const labelSize = computed(() => Math.max(props.sheetW, props.sheetH) * 0.022)

function boardW(s: SheetLayout): number {
  return s.boardWMm ?? props.sheetW
}
function boardH(s: SheetLayout): number {
  return s.boardHMm ?? props.sheetH
}
function viewBox(s: SheetLayout): string {
  const w = boardW(s)
  const h = boardH(s)
  return `-10 -10 ${w + 20} ${h + 20}`
}
function pieceW(p: { wMm: number }): number {
  return p.wMm
}
function sizeText(r: LeftoverRegion): string {
  return `${Math.round(r.wMm)}×${Math.round(r.hMm)}`
}
function hatchId(s: SheetLayout): string {
  return `scrapHatch-${s.index}`
}
function hatchUnit(s: SheetLayout): number {
  return Math.max(boardW(s), boardH(s)) * 0.022
}
</script>

<template>
  <div class="grid" :style="{ gridTemplateColumns: sheets.length > 1 ? 'repeat(2, minmax(0,1fr))' : 'minmax(0,1fr)' }">
    <div v-for="s in sheets" :key="s.index">
      <svg class="sheet-svg" :viewBox="viewBox(s)">
        <rect
          :x="0"
          :y="0"
          :width="boardW(s)"
          :height="boardH(s)"
          fill="#ffffff"
          stroke="#a9b4c6"
          :stroke-width="labelSize * 0.35"
        />
        <!-- 太窄太碎、不能再裁的区域：斜纹标出 -->
        <g v-for="(r, i) in s.scraps ?? []" :key="`sc${i}`">
          <rect
            :x="r.x"
            :y="r.y"
            :width="r.wMm"
            :height="r.hMm"
            :fill="`url(#${hatchId(s)})`"
            stroke="#c0584e"
            stroke-dasharray="6 5"
            :stroke-width="hatchUnit(s) * 0.1"
          />
        </g>
        <!-- 可登记再用的边角：绿色虚框 -->
        <g v-for="(r, i) in s.leftovers ?? []" :key="`lf${i}`">
          <rect
            :x="r.x"
            :y="r.y"
            :width="r.wMm"
            :height="r.hMm"
            fill="rgba(72, 149, 105, 0.08)"
            stroke="#489569"
            stroke-dasharray="10 6"
            :stroke-width="labelSize * 0.14"
          />
          <text
            :x="r.x + r.wMm / 2"
            :y="r.y + r.hMm / 2"
            class="svg-label muted"
            text-anchor="middle"
            dominant-baseline="middle"
            :style="{ fontSize: Math.max(9, Math.min(r.wMm, r.hMm) * 0.16) + 'px' }"
          >
            余料 {{ sizeText(r) }}
          </text>
        </g>
        <!-- 料层（一刀切到底的分层线） -->
        <line
          v-for="(sh, i) in s.shelves"
          :key="`sh${i}`"
          :x1="0"
          :y1="sh.y + sh.heightMm"
          :x2="boardW(s)"
          :y2="sh.y + sh.heightMm"
          stroke="#c8d2e2"
          :stroke-width="labelSize * 0.12"
          stroke-dasharray="8 6"
        />
        <g v-for="(p, i) in s.pieces" :key="`p${i}`">
          <rect
            :x="p.x"
            :y="p.y"
            :width="p.wMm"
            :height="p.hMm"
            :fill="p.rotated ? '#e8f1ff' : '#f2f7ee'"
            stroke="#3d6ea8"
            :stroke-width="labelSize * 0.16"
          />
          <text
            :x="p.x + pieceW(p) / 2"
            :y="p.y + p.hMm / 2"
            class="svg-label"
            text-anchor="middle"
            dominant-baseline="middle"
            :style="{ fontSize: Math.max(10, Math.min(p.wMm, p.hMm) * 0.28) + 'px' }"
          >
            {{ p.label }}
          </text>
        </g>
        <defs>
          <pattern
            :id="hatchId(s)"
            patternUnits="userSpaceOnUse"
            :width="hatchUnit(s) * 1.4"
            :height="hatchUnit(s) * 1.4"
            patternTransform="rotate(45)"
          >
            <rect width="100%" height="100%" fill="rgba(192, 88, 78, 0.05)" />
            <line x1="0" y1="0" x2="0" :y2="hatchUnit(s) * 1.4" stroke="rgba(192, 88, 78, 0.45)" :stroke-width="hatchUnit(s) * 0.14" />
          </pattern>
        </defs>
      </svg>
      <p class="muted">
        <span v-if="s.source?.kind === 'remnant'">余料 {{ s.source.remnantCode }}（{{ Math.round(boardW(s)) }}×{{ Math.round(boardH(s)) }}mm）</span>
        <span v-else>第 {{ s.index + 1 }} 张（新整板）</span>
        ：{{ s.pieces.length }} 件，用板面积
        {{ (s.usedAreaMm2 / 1e6).toFixed(3) }}㎡ / {{ (s.sheetAreaMm2 / 1e6).toFixed(3) }}㎡，利用率
        {{ (s.utilization * 100).toFixed(1) }}%
        <template v-if="(s.leftovers ?? []).length">；可登记余料 {{ s.leftovers!.map(sizeText).join('、') }}</template>
        <template v-if="(s.scraps ?? []).length">；红斜纹为过窄/过碎区域，不能再裁</template>
      </p>
    </div>
  </div>
</template>
