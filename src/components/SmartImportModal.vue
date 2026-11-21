<script setup>
import { ref, computed } from 'vue'
import { parseSmartBatchText, SMART_IMPORT_EXAMPLE } from '../utils/smartParser'
import { formatMoney } from '../utils/rmb'

const props = defineProps({
  visible: Boolean,
  customers: Array,
  products: Array
})

const emit = defineEmits(['close', 'confirmImport'])

const rawText = ref('')
const parsedList = ref([])
const errorTip = ref('')

function fillExample() {
  rawText.value = SMART_IMPORT_EXAMPLE
  runParse()
}

function clearAll() {
  rawText.value = ''
  parsedList.value = []
  errorTip.value = ''
}

function runParse() {
  errorTip.value = ''
  const res = parseSmartBatchText(rawText.value, props.customers, props.products)
  parsedList.value = res
  if (res.length === 0) {
    errorTip.value = '未能识别到有效订单，请按「客户名 日期 类目数量」格式输入（可点上方填入示例查看）'
  }
}

function recalcRecord(rec) {
  rec.totalAmount = Number(
    rec.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0).toFixed(2)
  )
}

function removeRecord(idx) {
  parsedList.value.splice(idx, 1)
}

const selectedRecords = computed(() => parsedList.value.filter((r) => r.selected && r.items.length > 0))
const totalImportAmount = computed(() =>
  selectedRecords.value.reduce((s, r) => s + (Number(r.totalAmount) || 0), 0)
)

function handleConfirm() {
  if (selectedRecords.value.length === 0) return alert('请先识别并勾选至少一条有效账单')
  emit('confirmImport', JSON.parse(JSON.stringify(selectedRecords.value)))
  clearAll()
}
</script>

<template>
  <div v-if="visible" class="modal-mask" @click.self="emit('close')">
    <div class="modal-sheet">
      <div class="modal-header">
        <button class="btn-sm" @click="emit('close')">取消</button>
        <span>智能批量导入（多客户一键识别）</span>
        <button class="btn-sm primary" @click="fillExample">填入示例</button>
      </div>

      <div class="modal-body">
        <div style="font-size:12px;color:#4B5563;background:#F3F4F6;border-radius:8px;padding:9px 10px;margin-bottom:10px;line-height:1.55;">
          <strong>格式说明（仿快递粘贴识别）：</strong>每行一个客户，直接粘贴微信报数即可，例如：<br />
          <code>留香东江酒店 11月21日 台布125 椅套7 席巾50 备注：早班车</code><br />
          支持自动识别日期（默认今天）、自动带出客户单价（或写 <code>台布125*1.2</code> 指定单价），不存在的新客户会自动建档。
        </div>

        <textarea
          v-model="rawText"
          rows="5"
          class="form-control"
          placeholder="在这里粘贴一个或多个客户的报数信息，点下方「智能识别」..."
          style="margin-bottom:10px;"
        ></textarea>

        <div style="display:flex;gap:8px;margin-bottom:12px;">
          <button class="btn-block btn-primary" style="flex:2;" @click="runParse">
            智能识别解析
          </button>
          <button class="btn-block btn-secondary" style="flex:1;" @click="clearAll">
            清空
          </button>
        </div>

        <div v-if="errorTip" style="color:#E54D42;font-size:13px;margin-bottom:10px;">
          {{ errorTip }}
        </div>

        <!-- 识别预览列表 -->
        <div v-if="parsedList.length > 0">
          <div style="font-weight:600;font-size:14px;margin-bottom:8px;">
            已识别 {{ parsedList.length }} 笔账单（可先核对或微调数量/单价）
          </div>

          <div
            v-for="(rec, idx) in parsedList"
            :key="rec.id"
            style="border:1px solid #D1D5DB;border-radius:10px;padding:10px;margin-bottom:10px;background:#FAFAFA;"
          >
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <label style="display:flex;align-items:center;gap:6px;font-weight:600;">
                <input v-model="rec.selected" type="checkbox" />
                <span>{{ rec.customerName }}</span>
                <span
                  v-if="rec.isNewCustomer"
                  class="tag"
                  style="background:#DBEAFE;color:#1D4ED8;"
                >
                  自动建新客户
                </span>
              </label>
              <div style="display:flex;align-items:center;gap:8px;">
                <strong style="color:#259B5E;">¥{{ formatMoney(rec.totalAmount) }}</strong>
                <button class="btn-sm danger" @click="removeRecord(idx)">删</button>
              </div>
            </div>

            <div style="font-size:12px;color:#6B7280;margin-bottom:8px;">
              日期：{{ rec.date }} · {{ rec.status === 'verified' ? '已核销' : '未核销' }}
              <span v-if="rec.remark"> · 备注：{{ rec.remark }}</span>
            </div>

            <div
              v-for="(it, iIdx) in rec.items"
              :key="iIdx"
              style="display:grid;grid-template-columns:1.2fr 0.9fr 0.9fr 0.9fr;gap:6px;align-items:center;margin-bottom:5px;font-size:13px;"
            >
              <span style="font-weight:500;">{{ it.name }}</span>
              <input
                v-model.number="it.qty"
                type="number"
                step="any"
                class="form-control"
                style="padding:4px 6px;font-size:14px;"
                @input="recalcRecord(rec)"
              />
              <input
                v-model.number="it.price"
                type="number"
                step="any"
                class="form-control"
                style="padding:4px 6px;font-size:14px;"
                @input="recalcRecord(rec)"
              />
              <span style="text-align:right;color:#259B5E;">¥{{ formatMoney(it.qty * it.price) }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="selectedRecords.length > 0" class="modal-footer">
        <button class="btn-block btn-primary" @click="handleConfirm">
          一键导入 {{ selectedRecords.length }} 笔账单（合计 ¥{{ formatMoney(totalImportAmount) }}）
        </button>
      </div>
    </div>
  </div>
</template>
