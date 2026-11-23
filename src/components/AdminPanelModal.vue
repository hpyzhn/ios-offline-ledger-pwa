<script setup>
import { ref, computed, watch } from 'vue'
import { db, saveSettings } from '../db/database'
import { formatMoney, numberToChineseRMB } from '../utils/rmb'

const props = defineProps({
  visible: Boolean,
  settings: Object,
  pendingSyncCount: Number
})

const emit = defineEmits(['close', 'updated', 'forceSync'])

const unlocked = ref(false)
const pinInput = ref('')
const pinError = ref('')

const tab = ref('orders') // 'orders' | 'logs' | 'security'
const allBills = ref([])
const auditLogs = ref([])
const searchQ = ref('')

// 当前正在纠错的订单
const editingOrder = ref(null)
const editItems = ref([])
const editStatus = ref('pending')
const editRemark = ref('')
const editReason = ref('')

// 修改管理员密码
const newPin = ref('')
const confirmPin = ref('')

async function loadAdminData() {
  allBills.value = (await db.bills.orderBy('date').reverse().toArray())
  auditLogs.value = (await db.auditLogs.orderBy('createdAt').reverse().limit(50).toArray())
}

watch(
  () => props.visible,
  (open) => {
    if (!open) {
      editingOrder.value = null
      pinInput.value = ''
      pinError.value = ''
      return
    }
    if (unlocked.value) loadAdminData()
  }
)

function verifyPin() {
  const expected = String(props.settings?.adminPin || '8888')
  if (pinInput.value.trim() === expected) {
    unlocked.value = true
    pinError.value = ''
    loadAdminData()
  } else {
    pinError.value = '管理员口令错误（默认口令：8888）'
  }
}

function lockAdmin() {
  unlocked.value = false
  editingOrder.value = null
  pinInput.value = ''
}

const filteredOrders = computed(() => {
  const q = searchQ.value.trim().toLowerCase()
  if (!q) return allBills.value
  return allBills.value.filter(
    (b) =>
      (b.customerName || '').toLowerCase().includes(q) ||
      (b.billNo || '').toLowerCase().includes(q) ||
      (b.date || '').includes(q) ||
      (b.items || []).some((i) => (i.name || '').toLowerCase().includes(q))
  )
})

function openOrderFix(bill) {
  editingOrder.value = bill
  editItems.value = (bill.items || []).map((i) => ({
    name: i.name,
    unit: i.unit || '条',
    qty: Number(i.qty) || 0,
    price: Number(i.price) || 0
  }))
  editStatus.value = bill.status || 'pending'
  editRemark.value = bill.remark || ''
  editReason.value = ''
}

function addFixRow() {
  editItems.value.push({ name: '', unit: '条', qty: 1, price: 1.0 })
}

function removeFixRow(idx) {
  if (editItems.value.length <= 1) return
  editItems.value.splice(idx, 1)
}

const fixedTotal = computed(() =>
  Number(
    editItems.value
      .reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0)
      .toFixed(2)
  )
)

async function saveOrderFix() {
  if (editItems.value.some(i => !Number.isFinite(Number(i.qty)) || !Number.isFinite(Number(i.price)) || Number(i.qty) < 0 || Number(i.price) < 0)) {
    return alert('数量和单价必须是有效的非负数')
  }
  const cleanItems = editItems.value
    .filter((i) => i.name && i.name.trim() && Number(i.qty) >= 0)
    .map((i) => ({
      name: i.name.trim(),
      unit: (i.unit || '条').trim(),
      qty: Number(i.qty) || 0,
      price: Number(i.price) || 0
    }))

  if (cleanItems.length === 0) return alert('请至少保留一项有效商品')
  if (!editReason.value.trim()) return alert('请填写纠错原因，便于日后对账审计')

  const savedTotal = Number(cleanItems.reduce((s, i) => s + i.qty * i.price, 0).toFixed(2))
  const oldBill = editingOrder.value
  const now = Date.now()
  const beforeSummary = (oldBill.items || [])
    .map((i) => `${i.name}:${i.qty}×¥${i.price}`)
    .join('，')
  const afterSummary = cleanItems
    .map((i) => `${i.name}:${i.qty}×¥${i.price}`)
    .join('，')

  // 即使断网也会写入本地并标为 pending，联网后自动上传云盘
  await db.transaction('rw', db.bills, db.auditLogs, async () => {
    await db.bills.update(oldBill.id, {
      items: cleanItems,
      totalAmount: savedTotal,
      status: editStatus.value,
      remark: editRemark.value.trim(),
      syncStatus: 'pending',
      updatedAt: now
    })

    await db.auditLogs.add({
      billId: oldBill.id,
      billNo: oldBill.billNo,
      customerName: oldBill.customerName,
      date: oldBill.date,
      beforeAmount: Number(oldBill.totalAmount) || 0,
      afterAmount: savedTotal,
      beforeSummary,
      afterSummary,
      reason: editReason.value.trim(),
      createdAt: now
    })

  })
  editingOrder.value = null
  await loadAdminData()
  emit('updated')
  alert('管理员纠错已保存（联网将自动同步至云端）')
}

async function handleChangePin() {
  const p1 = newPin.value.trim()
  if (p1.length < 4) return alert('新口令至少需要 4 位字符')
  if (p1 !== confirmPin.value.trim()) return alert('两次输入的口令不一致')
  await saveSettings({ adminPin: p1 })
  newPin.value = ''
  confirmPin.value = ''
  emit('updated')
  alert('管理员口令已更新')
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
</script>

<template>
  <div v-if="visible" class="modal-mask" @click.self="emit('close')">
    <div class="modal-sheet">
      <div class="modal-header">
        <button class="btn-sm" @click="emit('close')">关闭</button>
        <span>管理员后台 · 错单纠错</span>
        <button v-if="unlocked" class="btn-sm danger" @click="lockAdmin">锁定</button>
        <span v-else style="width: 44px;"></span>
      </div>

      <!-- 未解锁：输入管理员口令 -->
      <div v-if="!unlocked" class="modal-body" style="padding: 24px 18px;">
        <div style="text-align:center;margin-bottom:16px;">
          <div style="font-size:28px;margin-bottom:6px;">🔐</div>
          <div style="font-weight:600;font-size:16px;">请输入管理员口令</div>
          <div style="font-size:12px;color:#7F848A;margin-top:4px;">
            拥有强制修改已核销/错填数量及单价订单权限（初始口令：8888）
          </div>
        </div>
        <div class="form-group">
          <input
            v-model="pinInput"
            type="password"
            class="form-control"
            placeholder="输入管理员口令"
            @keyup.enter="verifyPin"
          />
          <div v-if="pinError" style="color:#E54D42;font-size:12px;margin-top:6px;">{{ pinError }}</div>
        </div>
        <button class="btn-block btn-primary" style="width:100%;" @click="verifyPin">验证并进入后台</button>
      </div>

      <!-- 已解锁：正在编辑单个错单 -->
      <div v-else-if="editingOrder" class="modal-body">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <strong>修正单据：{{ editingOrder.billNo }}（{{ editingOrder.customerName }}）</strong>
          <button class="btn-sm" @click="editingOrder = null">返回列表</button>
        </div>
        <div style="font-size:12px;color:#7F848A;margin-bottom:12px;">
          原日期：{{ editingOrder.date }} · 原总额：¥{{ formatMoney(editingOrder.totalAmount) }}
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span class="form-label" style="margin:0;">直接修改错误的数量或单价</span>
          <button class="btn-sm primary" @click="addFixRow">+ 补录一行</button>
        </div>

        <div
          v-for="(item, idx) in editItems"
          :key="idx"
          style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:10px;margin-bottom:8px;"
        >
          <div style="display:flex;gap:8px;margin-bottom:8px;">
            <input v-model="item.name" class="form-control" placeholder="类目名" style="flex:1;" />
            <button v-if="editItems.length > 1" class="btn-sm danger" @click="removeFixRow(idx)">删</button>
          </div>
          <div class="grid-3">
            <div>
              <span class="form-label">正确数量</span>
              <input v-model.number="item.qty" type="number" step="any" class="form-control" />
            </div>
            <div>
              <span class="form-label">正确单价(元)</span>
              <input v-model.number="item.price" type="number" step="any" class="form-control" />
            </div>
            <div>
              <span class="form-label">单位</span>
              <input v-model="item.unit" class="form-control" />
            </div>
          </div>
          <div style="text-align:right;font-size:12px;color:#259B5E;font-weight:600;margin-top:6px;">
            修正后小计：¥{{ formatMoney((Number(item.qty) || 0) * (Number(item.price) || 0)) }}
          </div>
        </div>

        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">核销状态</label>
            <select v-model="editStatus" class="form-control">
              <option value="pending">未核销</option>
              <option value="verified">已核销</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">备注</label>
            <input v-model="editRemark" class="form-control" />
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">纠错原因（必填，写入审计日志）</label>
          <input v-model="editReason" class="form-control" placeholder="例如：台布数量多录10条 / 单价错填为1.8" />
        </div>

        <div style="background:#FEF3C7;border-radius:8px;padding:10px;margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;font-size:14px;">
            <span>修正后总额：</span>
            <strong style="color:#B45309;font-size:18px;">¥{{ formatMoney(fixedTotal) }}</strong>
          </div>
          <div style="font-size:12px;color:#92400E;">大写：{{ numberToChineseRMB(fixedTotal) }}</div>
        </div>

        <button class="btn-block btn-primary" style="width:100%;" @click="saveOrderFix">
          确认覆盖修正并记录日志
        </button>
      </div>

      <!-- 已解锁：管理员主面板 -->
      <div v-else class="modal-body">
        <div style="display:flex;gap:8px;margin-bottom:12px;">
          <button class="btn-sm" :class="tab === 'orders' ? 'primary' : ''" @click="tab = 'orders'">
            全部订单纠错 ({{ allBills.length }})
          </button>
          <button class="btn-sm" :class="tab === 'logs' ? 'primary' : ''" @click="tab = 'logs'">
            改单日志 ({{ auditLogs.length }})
          </button>
          <button class="btn-sm" :class="tab === 'security' ? 'primary' : ''" @click="tab = 'security'">
            口令与同步
          </button>
        </div>

        <!-- Tab 1: 订单列表纠错 -->
        <div v-if="tab === 'orders'">
          <input
            v-model="searchQ"
            class="form-control"
            placeholder="搜索客户名、日期(2026-11)、单号或类目..."
            style="margin-bottom:10px;"
          />
          <div v-if="filteredOrders.length === 0" class="empty-state" style="padding:28px;">暂无匹配订单</div>
          <div
            v-for="b in filteredOrders"
            :key="b.id"
            style="border:1px solid #EAECEF;border-radius:8px;padding:10px;margin-bottom:8px;background:#FAFAFA;"
          >
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div>
                <strong>{{ b.customerName }}</strong>
                <span class="tag" :class="b.status === 'verified' ? 'tag-verified' : 'tag-pending'" style="margin-left:6px;">
                  {{ b.status === 'verified' ? '已核销' : '未核销' }}
                </span>
                <span v-if="b.syncStatus === 'pending'" class="tag" style="background:#FEE2E2;color:#B91C1C;margin-left:4px;">
                  待上传
                </span>
              </div>
              <strong>¥{{ formatMoney(b.totalAmount) }}</strong>
            </div>
            <div style="font-size:12px;color:#7F848A;margin:4px 0;">
              {{ b.date }} · {{ b.billNo }}
            </div>
            <div style="font-size:12px;color:#4B5563;margin-bottom:8px;">
              {{ (b.items || []).map((i) => `${i.name} ${i.qty}×¥${i.price}`).join(' | ') }}
            </div>
            <button class="btn-sm primary" @click="openOrderFix(b)">修正数量 / 单价</button>
          </div>
        </div>

        <!-- Tab 2: 管理员改单审计日志 -->
        <div v-else-if="tab === 'logs'">
          <div v-if="auditLogs.length === 0" class="empty-state" style="padding:28px;">暂无管理员修改记录</div>
          <div
            v-for="log in auditLogs"
            :key="log.id"
            style="border:1px solid #EAECEF;border-radius:8px;padding:10px;margin-bottom:8px;font-size:12px;"
          >
            <div style="display:flex;justify-content:space-between;font-weight:600;margin-bottom:4px;">
              <span>{{ log.customerName }} · {{ log.billNo }}</span>
              <span style="color:#7F848A;">{{ fmtTime(log.createdAt) }}</span>
            </div>
            <div>金额变更：¥{{ formatMoney(log.beforeAmount) }} → <strong style="color:#B45309;">¥{{ formatMoney(log.afterAmount) }}</strong></div>
            <div style="color:#6B7280;margin-top:3px;">改前：{{ log.beforeSummary }}</div>
            <div style="color:#259B5E;margin-top:2px;">改后：{{ log.afterSummary }}</div>
            <div style="color:#111827;margin-top:4px;"><strong>原因：</strong>{{ log.reason }}</div>
          </div>
        </div>

        <!-- Tab 3: 口令修改与离线补传检查 -->
        <div v-else>
          <div style="background:#F3F4F6;border-radius:8px;padding:12px;margin-bottom:14px;">
            <div style="font-weight:600;margin-bottom:4px;">离线数据同步状态</div>
            <div style="font-size:13px;color:#4B5563;margin-bottom:8px;">
              当前本地待上传云端的离线账单数：<strong>{{ pendingSyncCount }}</strong> 条
            </div>
            <button class="btn-sm primary" @click="emit('forceSync')">立即检测并上传未同步数据</button>
          </div>

          <div class="form-group">
            <label class="form-label">设置新的管理员口令</label>
            <input v-model="newPin" type="password" class="form-control" placeholder="输入新口令（至少4位）" />
          </div>
          <div class="form-group">
            <label class="form-label">确认新口令</label>
            <input v-model="confirmPin" type="password" class="form-control" placeholder="再次输入新口令" />
          </div>
          <button class="btn-block btn-primary" style="width:100%;" @click="handleChangePin">保存新口令</button>
        </div>
      </div>
    </div>
  </div>
</template>
