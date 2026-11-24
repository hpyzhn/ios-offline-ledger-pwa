<script setup>
import { ref, computed, watch } from 'vue'
import { formatMoney, numberToChineseRMB } from '../utils/rmb'
import { buildSettlementPreview, exportSettlementExcel } from '../utils/exportExcel'
import { readExportTemplate } from '../db/database'
import TemplateEditorModal from '../components/TemplateEditorModal.vue'

const props = defineProps({
  month: String,
  bills: Array,
  customers: Array,
  settings: Object,
  loading: Boolean,
  loadError: String
})

const emit = defineEmits(['update:month', 'saveCustomerTemplate', 'retry'])

const selectedKey = ref('')
const showTemplateEditor = ref(false)

// 账单按客户名称归属。客户档案已删除或稍后才同步时，仍按名称分别结算。
const settlementCustomers = computed(() => {
  const list = (props.customers || []).filter(c => typeof c?.name === 'string' && c.name.trim())
  const names = new Set(list.map(c => c.name))
  for (const bill of props.bills || []) {
    const name = bill?.customerName
    if (typeof name !== 'string' || !name.trim() || names.has(name)) continue
    names.add(name)
    list.push({ name })
  }
  return list
})

function customerKey(c) {
  return c.id == null ? 'history:' + c.name : 'profile:' + typeof c.id + ':' + c.id
}

watch(settlementCustomers, (list, previous) => {
  if (list.some(c => customerKey(c) === selectedKey.value)) return
  const oldName = previous?.find(c => customerKey(c) === selectedKey.value)?.name
  const next = list.find(c => c.name === oldName) || list[0]
  selectedKey.value = next ? customerKey(next) : ''
}, { immediate: true })
watch(selectedKey, () => { showTemplateEditor.value = false })

const currentCustomer = computed(() =>
  settlementCustomers.value.find(c => customerKey(c) === selectedKey.value)
)

const currentTemplate = computed(() =>
  readExportTemplate(currentCustomer.value, props.settings?.companyName)
)

const previewResult = computed(() => {
  if (props.loading || props.loadError || !currentCustomer.value || !props.month) return {}
  try {
    const data = buildSettlementPreview({
      month: props.month,
      customer: currentCustomer.value,
      bills: props.bills,
      template: currentTemplate.value,
      fallbackTitle: props.settings?.companyName
    })
    return { data }
  } catch (error) {
    return { error: error.message }
  }
})
const preview = computed(() => previewResult.value.data)

const exporting = ref(false)
async function handleExport() {
  if (exporting.value || !preview.value) return
  exporting.value = true
  try {
    await exportSettlementExcel({
      month: props.month,
      customer: currentCustomer.value,
      bills: props.bills,
      template: currentTemplate.value,
      fallbackTitle: props.settings?.companyName
    })
  } catch (err) {
    alert('导出失败：' + (err?.message || err))
  } finally {
    exporting.value = false
  }
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
          aria-label="结算月份"
          class="month-input"
          :value="month"
          @input="emit('update:month', $event.target.value)"
        />
        <select
          v-if="settlementCustomers.length"
          v-model="selectedKey"
          aria-label="结算客户"
          class="pill-btn"
          style="color:#FFFFFF;background:rgba(0,0,0,0.2);font-weight:600;"
        >
          <option v-for="c in settlementCustomers" :key="customerKey(c)" :value="customerKey(c)" style="color:#111;">
            {{ c.name }}
          </option>
        </select>
      </div>

      <template v-if="preview">
        <div style="font-size:13px;opacity:0.92;">
          {{ preview.customerName }} · {{ month }} 月度结算总额（{{ preview.filteredBills.length }} 笔）
        </div>
        <div style="font-size:34px;font-weight:700;margin:4px 0;">¥ {{ formatMoney(preview.grandTotal) }}</div>
        <div style="font-size:12px;opacity:0.92;">大写：{{ numberToChineseRMB(preview.grandTotal) }}</div>
      </template>
      <div v-else-if="loadError" role="alert">
        <p>{{ loadError }}</p>
        <button class="pill-btn" @click="emit('retry')">重新读取账本</button>
      </div>
      <p v-else-if="!month" role="status">请选择结算月份。</p>
      <p v-else-if="loading" role="status">正在读取本月账本…</p>
      <p v-else-if="!currentCustomer" role="status">本月暂无可结算的客户。可在「客户设置」添加客户，或同步已有账本。</p>
      <p v-else role="alert">无法生成本月结算表：{{ previewResult.error }}</p>
    </header>

    <div v-if="preview || previewResult.error" style="padding: 12px; display: flex; flex-direction: column; gap: 12px;">
      <!-- 导出与定制模板操作条 -->
      <div style="display:flex;gap:8px;">
        <button v-if="preview" class="btn-block btn-primary" style="flex:1.6;" :disabled="exporting" @click="handleExport">
          {{ exporting ? '正在导出...' : '导出结算表 Excel (.xlsx)' }}
        </button>
        <button v-if="currentCustomer?.id != null" class="btn-block btn-secondary" style="flex:1;" @click="showTemplateEditor = true">
          定制输出格式
        </button>
      </div>

      <!-- 实时横向矩阵预览（左右滑动可看 1~31 日 + 动态尾列） -->
      <div v-if="preview" class="bill-card" style="padding:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <strong style="font-size:14px;">{{ preview.sheetTitle }}（实时预览）</strong>
          <span v-if="currentTemplate.showDate !== false" style="font-size:12px;color:#7F848A;">{{ preview.settlementDate }}</span>
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
          左右滑动可查看 1~31 日明细。<span v-if="currentCustomer.id == null">该客户尚无档案，当前按账单名称结算。</span>
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
