<script setup>
import { billTotal } from '../utils/money.js'
import { ref, computed, watch } from 'vue'
import { numberToChineseRMB, formatMoney } from '../utils/rmb'

function formatLocalDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const props = defineProps({
  visible: Boolean,
  saving: Boolean,
  customers: Array,
  products: Array,
  editingBill: Object,
  defaultCustomerName: String,
  defaultDate: String
})

const emit = defineEmits(['close', 'save', 'quickAddCategory'])

const selectedCustomerName = ref('')
const date = ref('')
const paymentMethod = ref('月结挂账')
const status = ref('pending')
const remark = ref('')
const entryRows = ref([])

// 快捷新增预输入类目
const showAddCat = ref(false)
const newCatName = ref('')
const newCatPrice = ref(1.0)
const newCatUnit = ref('条')
const saveToCustomer = ref(true)

function buildRowsForCustomer(custName, existingItems = []) {
  const cust = (props.customers || []).find((c) => c.name === custName)
  const existingMap = new Map(existingItems.map((i) => [i.name, i]))

  const baseList =
    cust && Array.isArray(cust.categories) && cust.categories.length
      ? cust.categories.filter((c) => c.enabled !== false)
      : (props.products || []).map((p) => ({ name: p.name, unit: p.unit, price: p.defaultPrice }))

  const rows = baseList.map((cat) => {
    const old = existingMap.get(cat.name)
    existingMap.delete(cat.name)
    return {
      name: cat.name,
      unit: old?.unit ?? cat.unit ?? '件',
      price: old ? Number(old.price) : Number(cat.price) || 0,
      qty: old ? Number(old.qty) : ''
    }
  })

  // 补齐历史账单里存在但不在固定类目里的项
  existingMap.forEach((old) => {
    rows.push({
      name: old.name,
      unit: old.unit || '件',
      price: Number(old.price) || 0,
      qty: Number(old.qty) || ''
    })
  })
  return rows
}

watch(
  () => props.visible,
  (open) => {
    if (!open) return
    showAddCat.value = false
    if (props.editingBill) {
      selectedCustomerName.value = props.editingBill.customerName
      date.value = props.editingBill.date
      paymentMethod.value = props.editingBill.paymentMethod || '月结挂账'
      status.value = props.editingBill.status || 'pending'
      remark.value = props.editingBill.remark || ''
      entryRows.value = buildRowsForCustomer(
        props.editingBill.customerName,
        props.editingBill.items || []
      )
    } else {
      const initName = props.defaultCustomerName || props.customers?.[0]?.name || ''
      selectedCustomerName.value = initName
      date.value = props.defaultDate || formatLocalDate()
      paymentMethod.value = '月结挂账'
      status.value = 'pending'
      remark.value = ''
      entryRows.value = buildRowsForCustomer(initName)
    }
  }
)

function onCustomerSwitch() {
  if (!props.editingBill) {
    entryRows.value = buildRowsForCustomer(selectedCustomerName.value)
  }
}

function handleQuickAddCategory() {
  const name = newCatName.value.trim()
  if (!name) return alert('请输入新类目名称')
  if (entryRows.value.some((r) => r.name === name)) {
    return alert('该类目已在列表中')
  }
  const price = Number(newCatPrice.value)
  if (!Number.isFinite(price) || price < 0) return alert('单价必须是有效的非负数')
  const newItem = {
    name,
    unit: newCatUnit.value.trim() || '条',
    price,
    qty: ''
  }
  entryRows.value.push(newItem)

  if (saveToCustomer.value && selectedCustomerName.value) {
    emit('quickAddCategory', {
      customerName: selectedCustomerName.value,
      category: { name: newItem.name, unit: newItem.unit, price: newItem.price, enabled: true }
    })
  }
  newCatName.value = ''
  newCatPrice.value = 1.0
  showAddCat.value = false
}

const filledItems = computed(() =>
  entryRows.value
    .filter((r) => Number.isFinite(Number(r.qty)) && Number(r.qty) > 0)
    .map((r) => ({
      name: r.name,
      unit: r.unit,
      qty: Number(r.qty),
      price: Number(r.price) || 0
    }))
)

const totalAmount = computed(() =>
  billTotal(filledItems.value)
)

function handleSubmit() {
  // 保存进行中时禁止重复提交，防止并发写入产生重复账单
  if (props.saving) return
  if (!selectedCustomerName.value) return alert('请先选择合作商家/客户')
  if (!date.value || !/^\d{4}-\d{2}-\d{2}$/.test(date.value)) return alert('请选择有效日期')
  if (filledItems.value.length === 0) return alert('请至少为一个类目填写大于 0 的数量')
  if (filledItems.value.some((i) => !Number.isFinite(i.price) || i.price < 0)) {
    return alert('单价必须是有效的非负数，请先在客户设置中修正类目单价')
  }
  if (!Number.isFinite(totalAmount.value)) return alert('数量或单价超出有效范围，请检查输入')

  emit('save', {
    id: props.editingBill?.id,
    billNo: props.editingBill?.billNo,
    // 乐观并发控制基线：保存时与库内最新 updatedAt 比对，防止覆盖其他窗口/设备的修改
    baseUpdatedAt: props.editingBill?.updatedAt,
    customerName: selectedCustomerName.value,
    date: date.value,
    month: date.value.slice(0, 7),
    paymentMethod: paymentMethod.value,
    status: status.value,
    remark: remark.value.trim(),
    items: filledItems.value,
    totalAmount: totalAmount.value
  })
}
</script>

<template>
  <div v-if="visible" class="modal-mask" @click.self="emit('close')">
    <div class="modal-sheet">
      <div class="modal-header">
        <button class="btn-sm" @click="emit('close')">取消</button>
        <span>{{ editingBill ? '编辑当日记账' : '记一笔（按固定类目填数）' }}</span>
        <span style="width: 44px;"></span>
      </div>

      <div class="modal-body">
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">客户 / 合作商家</label>
            <select v-model="selectedCustomerName" class="form-control" @change="onCustomerSwitch">
              <option v-for="c in customers" :key="c.id" :value="c.name">{{ c.name }}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">日期（自动归入结算表对应日列）</label>
            <input v-model="date" type="date" class="form-control" />
          </div>
        </div>

        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">收款方式</label>
            <select v-model="paymentMethod" class="form-control">
              <option value="月结挂账">月结挂账</option>
              <option value="微信">微信</option>
              <option value="银行转账">银行转账</option>
              <option value="现金">现金</option>
              <option value="支付宝">支付宝</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">核销状态</label>
            <select v-model="status" class="form-control">
              <option value="pending">未核销</option>
              <option value="verified">已核销</option>
            </select>
          </div>
        </div>

        <!-- 固定类目快捷填数列表 -->
        <div class="form-group">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <label class="form-label" style="margin:0;">固定类目（直接填数量，空着不计入）</label>
            <button class="btn-sm primary" type="button" @click="showAddCat = !showAddCat">
              {{ showAddCat ? '收起' : '+ 新增预输入类目' }}
            </button>
          </div>

          <!-- 快捷新增预输入类目面板 -->
          <div
            v-if="showAddCat"
            style="background:#E8F8F0;border:1px solid #2EB872;border-radius:8px;padding:10px;margin-bottom:10px;"
          >
            <div class="grid-3" style="margin-bottom:8px;">
              <div>
                <span class="form-label">新类目名</span>
                <input v-model="newCatName" class="form-control" placeholder="如：口布" />
              </div>
              <div>
                <span class="form-label">单价(元)</span>
                <input v-model.number="newCatPrice" type="number" step="any" class="form-control" />
              </div>
              <div>
                <span class="form-label">单位</span>
                <input v-model="newCatUnit" class="form-control" placeholder="条/个" />
              </div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <label style="font-size:13px;display:flex;align-items:center;gap:6px;">
                <input v-model="saveToCustomer" type="checkbox" />
                永久加入「{{ selectedCustomerName }}」固定类目
              </label>
              <button class="btn-sm primary" type="button" @click="handleQuickAddCategory">确认添加</button>
            </div>
          </div>

          <div
            v-for="row in entryRows"
            :key="row.name"
            style="display:grid;grid-template-columns:1.2fr 1fr 0.9fr;gap:8px;align-items:center;padding:8px 10px;border:1px solid #EAECEF;border-radius:8px;margin-bottom:6px;background:#FAFAFA;"
          >
            <div>
              <div style="font-weight:600;font-size:14px;">{{ row.name }}</div>
              <div style="font-size:12px;color:#7F848A;">¥{{ row.price }}/{{ row.unit }}</div>
            </div>
            <input
              v-model.number="row.qty"
              type="number"
              step="any"
              min="0"
              class="form-control"
              placeholder="数量"
              style="padding:6px 8px;"
            />
            <div style="text-align:right;font-size:13px;font-weight:600;color:#259B5E;">
              {{ Number(row.qty) > 0 ? '¥' + formatMoney(row.qty * row.price) : '-' }}
            </div>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">车号 / 备注</label>
          <input v-model="remark" class="form-control" placeholder="选填：送货车次、返洗说明等" />
        </div>

        <div style="background:#E8F8F0;border-radius:8px;padding:12px;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;">
            <span style="font-size:14px;color:#259B5E;">本单合计（已填 {{ filledItems.length }} 项）</span>
            <span style="font-size:22px;font-weight:700;color:#115E59;">¥{{ formatMoney(totalAmount) }}</span>
          </div>
          <div style="font-size:12px;color:#259B5E;margin-top:4px;">
            大写：{{ numberToChineseRMB(totalAmount) }}
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn-block btn-primary" :disabled="saving" @click="handleSubmit">
          {{ saving ? '正在保存...' : '保存本地账单' }}
        </button>
      </div>
    </div>
  </div>
</template>
