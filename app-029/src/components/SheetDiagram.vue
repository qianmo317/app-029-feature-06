<script setup lang="ts">
import { computed } from 'vue'
import type { NestingResult, SheetLayout } from '../logic/nesting'

const props = defineProps<{
  nesting: NestingResult
  /** 整板尺寸（未在余料板模式下使用；各板以自身 wMm/hMm 绘制） */
  sheetW: number
  sheetH: number
  active?: number
}>()

const sheets = computed<SheetLayout[]>(() => props.nesting.sheets)
const labelSize = computed(() => Math.max(props.sheetW, props.sheetH) * 0.022)

function vb(s: SheetLayout): string {
  return `-10 -10 ${s.wMm + 20} ${s.hMm + 20}`
}

function patternId(s: SheetLayout, i: number): string {
  return `scrap-${s.index}-${i}`
}
function scrapRegions(s: SheetLayout) {
  return s.freeRegions.filter((x) => x.kind === 'scrap')
}
</script>

<template>
  <div class="grid" :style="{ gridTemplateColumns: sheets.length > 1 ? 'repeat(2, minmax(0,1fr))' : 'minmax(0,1fr)' }">
    <div v-for="s in sheets" :key="s.index">
      <svg class="sheet-svg" :viewBox="vb(s)">
        <rect
          :x="0"
          :y="0"
          :width="s.wMm"
          :height="s.hMm"
          fill="#ffffff"
          stroke="#a9b4c6"
          :stroke-width="labelSize * 0.35"
        />
        <!-- 可登记余料区域（绿色淡底） -->
        <rect
          v-for="(r, i) in s.freeRegions.filter((x) => x.kind === 'usable')"
          :key="`u${i}`"
          :x="r.x"
          :y="r.y"
          :width="r.wMm"
          :height="r.hMm"
          fill="#dff3df"
          fill-opacity="0.7"
          stroke="#3f8f4f"
          :stroke-width="labelSize * 0.12"
          stroke-dasharray="10 6"
        />
        <text
          v-for="(r, i) in s.freeRegions.filter((x) => x.kind === 'usable')"
          :key="`ut${i}`"
          :x="r.x + r.wMm / 2"
          :y="r.y + r.hMm / 2"
          class="svg-label"
          text-anchor="middle"
          dominant-baseline="middle"
          fill="#2c6b39"
          :style="{ fontSize: Math.max(9, Math.min(r.wMm, r.hMm) * 0.16) + 'px' }"
        >
          余料 {{ Math.round(r.wMm) }}×{{ Math.round(r.hMm) }}
        </text>
        <!-- 废料区域（斜纹，标「不能再裁」） -->
        <pattern
          v-for="(_r, i) in scrapRegions(s)"
          :id="patternId(s, i)"
          :key="`pt${i}`"
          :width="Math.max(12, labelSize * 1.6)"
          :height="Math.max(12, labelSize * 1.6)"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="100%" height="100%" fill="#f3f0ea" />
          <line x1="0" :y1="0" x2="0" :y2="Math.max(12, labelSize * 1.6)" stroke="#c2b9a6" :stroke-width="labelSize * 0.18" />
        </pattern>
        <rect
          v-for="(r, i) in scrapRegions(s)"
          :key="`sc${i}`"
          :x="r.x"
          :y="r.y"
          :width="r.wMm"
          :height="r.hMm"
          :fill="`url(#${patternId(s, i)})`"
          stroke="#b3a98f"
          :stroke-width="labelSize * 0.1"
        />
        <text
          v-for="(r, i) in scrapRegions(s)"
          :key="`sct${i}`"
          :x="r.x + r.wMm / 2"
          :y="r.y + r.hMm / 2"
          class="svg-label"
          text-anchor="middle"
          dominant-baseline="middle"
          fill="#8a7d5f"
          :style="{ fontSize: Math.max(8, Math.min(r.wMm, r.hMm) * 0.14) + 'px' }"
        >
          废料·不能再裁
        </text>
        <!-- 料层（一刀切到底的分层线） -->
        <line
          v-for="(sh, i) in s.shelves"
          :key="`sh${i}`"
          :x1="0"
          :y1="sh.y + sh.heightMm"
          :x2="s.wMm"
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
            :x="p.x + p.wMm / 2"
            :y="p.y + p.hMm / 2"
            class="svg-label"
            text-anchor="middle"
            dominant-baseline="middle"
            :style="{ fontSize: Math.max(10, Math.min(p.wMm, p.hMm) * 0.28) + 'px' }"
          >
            {{ p.label }}
          </text>
        </g>
      </svg>
      <p class="muted">
        <template v-if="s.remnantId">余料板 {{ s.wMm }}×{{ s.hMm }}mm</template>
        <template v-else>第 {{ s.index + 1 }} 张（{{ s.wMm }}×{{ s.hMm }}mm）</template>
        ：{{ s.pieces.length }} 件，用板面积
        {{ (s.usedAreaMm2 / 1e6).toFixed(3) }}㎡ / {{ (s.sheetAreaMm2 / 1e6).toFixed(3) }}㎡，利用率
        {{ (s.utilization * 100).toFixed(1) }}%
      </p>
    </div>
  </div>
  <p class="muted" v-if="sheets.some((s) => s.freeRegions.length > 0)" style="margin-top: 6px">
    图例：<b style="color: #2c6b39">绿色虚线框＝可登记余料</b>（短边够用，登记后下次可当板材选）；
    <b style="color: #8a7d5f">斜纹底＝废料</b>（太窄太碎，不能再裁，仅标注）。锯缝统一按 1 条扣，靠边不扣。
  </p>
</template>
