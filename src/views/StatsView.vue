<script setup>
import { ref, computed, watch } from 'vue'
import { formatMoney, numberToChineseRMB } from '../utils/rmb'
import { buildSettlementPreview, exportSettlementExcel } from '../utils/exportExcel'
import { createDefaultExportTemplate } from '../db/database'
import TemplateEditorModal from '../components/TemplateEditorModal.vue'

const props = defineProps({
  month: String,
  bills: Array,
  customers: Array,
  settings: Object
})

const emit = defineEmits(['update:month', 'saveCustomerTemplate'])

const selectedCustomerId = ref(null)
const showTemplateEditor = ref(false)

watch(
  () => props.customers,
  (list) => {
    if (list?.length && !list.some((c) => c.id === selectedCustomerId.value)) {
      selectedCustomerId.value = list[0].id
    }
  },
  { immediate: true }
)

const currentCustomer = computed(() =>
  (props.customers || []).find((c) => c.id === selectedCustomerId.value) || null
)

const currentTemplate = computed(() =>
  currentCustomer.value?.exportTemplate || createDefaultExportTemplate(props.settings?.companyName)
)

const preview = computed(() =>
  buildSettlementPreview({
    month: props.month,
    customer: currentCustomer.value,
    bills: props.bills,
    template: currentTemplate.value,
    fallbackTitle: props.settings?.companyName
  })
)

async function handleExport() {
  await exportSettlementExcel({
    month: props.month,
    customer: currentCustomer.value,
    bills: props.bills,
    template: currentTemplate.value,
    fallbackTitle: props.settings?.companyName
  })
}

function onSaveTemplate(payload) {
  emit('saveCustomerTemplate', payload)
  showTemplateEditor.value = false
}
</script>

<template>
  <div>
    <header class="wx-header" style="padding-bottom: 20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
        <input
          type="month"
          class="month-input"
          :value="month"
          @input="emit('update:month', $event.target.value)"
        />
        <select
          v-model="selectedCustomerId"
          class="pill-btn"
          style="color:#FFFFFF;background:rgba(0,0,0,0.2);font-weight:600;"
        >
          <option v-for="c in customers" :key="c.id" :value="c.id" style="color:#111;">
            {{ c.name }}
          </option>
        </select>
      </div>

      <div style="font-size:13px;opacity:0.92;">
        {{ preview.customerName }} · {{ month }} 月度结算总额（{{ preview.filteredBills.length }} 笔）
      </div>
      <div style="font-size:34px;font-weight:700;margin:4px 0;">¥ {{ formatMoney(preview.grandTotal) }}</div>
      <div style="font-size:12px;opacity:0.92;">大写：{{ numberToChineseRMB(preview.grandTotal) }}</div>
    </header>

    <div style="padding: 12px; display: flex; flex-direction: column; gap: 12px;">
      <!-- 导出与定制模板操作条 -->
      <div style="display:flex;gap:8px;">
        <button class="btn-block btn-primary" style="flex:1.6;" @click="handleExport">
          导出结算表 Excel (.xlsx)
        </button>
        <button class="btn-block btn-secondary" style="flex:1;" @click="showTemplateEditor = true">
          定制输出格式
        </button>
      </div>

      <!-- 实时横向矩阵预览（左右滑动可看 1~31 日 + 动态尾列） -->
      <div class="bill-card" style="padding:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <strong style="font-size:14px;">{{ preview.sheetTitle }}（实时预览）</strong>
          <span style="font-size:12px;color:#7F848A;">{{ preview.settlementDate }}</span>
        </div>

        <div class="matrix-scroll">
          <table class="matrix-table">
            <thead>
              <tr>
                <th class="sticky-col">名称</th>
                <th v-for="d in 31" :key="d">{{ d }}</th>
                <th v-for="col in preview.activeTailCols" :key="col.key">{{ col.label }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in preview.rows" :key="r.name">
                <td class="sticky-col">{{ r.name }}</td>
                <td v-for="(val, idx) in r.days" :key="idx">{{ val || '' }}</td>
                <td v-for="col in preview.activeTailCols" :key="col.key" style="font-weight:600;">
                  <template v-if="col.key === 'totalQty'">{{ r.totalQty }}</template>
                  <template v-else-if="col.key === 'unitPrice'">{{ r.price }}</template>
                  <template v-else-if="col.key === 'totalAmount'">{{ formatMoney(r.totalAmount) }}</template>
                  <template v-else-if="col.key === 'unit'">{{ r.unit }}</template>
                  <template v-else-if="col.key === 'verifyStatus'">
                    {{ r.pendingCount === 0 && r.verifiedCount > 0 ? '已核销' : (r.pendingCount > 0 ? '含未核销' : '') }}
                  </template>
                  <template v-else-if="col.key === 'remark'">{{ Array.from(r.remarks).join('；') }}</template>
                  <template v-else>{{ col.defaultValue || '' }}</template>
                </td>
              </tr>
              <tr v-if="currentTemplate.includeTotalRow !== false && preview.rows.length">
                <td class="sticky-col">合计</td>
                <td colspan="31" style="text-align:right;color:#7F848A;">总计</td>
                <td v-for="col in preview.activeTailCols" :key="col.key" style="font-weight:700;color:#259B5E;">
                  <template v-if="col.key === 'totalQty'">{{ preview.grandQty }}</template>
                  <template v-else-if="col.key === 'totalAmount'">¥{{ formatMoney(preview.grandTotal) }}</template>
                  <template v-else></template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style="font-size:12px;color:#7F848A;margin-top:8px;">
          提示：表格左右滑动可查看 1~31 日明细；点击「定制输出格式」可为「{{ preview.customerName }}」保存独立表头、状态筛选与额外栏目。
        </div>
      </div>
    </div>

    <TemplateEditorModal
      :visible="showTemplateEditor"
      :customer="currentCustomer"
      :default-title="settings?.companyName"
      @close="showTemplateEditor = false"
      @save="onSaveTemplate"
    />
  </div>
</template>
