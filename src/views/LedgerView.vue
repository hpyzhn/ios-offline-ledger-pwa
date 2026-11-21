<script setup>
import { ref, computed } from 'vue'
import { formatMoney } from '../utils/rmb'
import FilterDrawer from '../components/FilterDrawer.vue'

const props = defineProps({
  month: String,
  bills: Array,
  customers: Array,
  isOnline: Boolean,
  currentUser: Object,
  pendingSyncCount: Number,
  syncBanner: String
})

const emit = defineEmits(['update:month', 'create', 'edit', 'delete', 'toggleVerify', 'preview', 'openAuth', 'openAdmin', 'openSmartImport'])

const showFilter = ref(false)
const selectedCustomer = ref('')
const statusFilter = ref('all')
const keyword = ref('')

const filteredBills = computed(() => {
  return (props.bills || []).filter((b) => {
    if (selectedCustomer.value && b.customerName !== selectedCustomer.value) return false
    if (statusFilter.value !== 'all' && b.status !== statusFilter.value) return false
    if (keyword.value.trim()) {
      const q = keyword.value.trim().toLowerCase()
      const hitCust = (b.customerName || '').toLowerCase().includes(q)
      const hitNo = (b.billNo || '').toLowerCase().includes(q)
      const hitRemark = (b.remark || '').toLowerCase().includes(q)
      const hitItem = (b.items || []).some((i) => (i.name || '').toLowerCase().includes(q))
      if (!hitCust && !hitNo && !hitRemark && !hitItem) return false
    }
    return true
  })
})

const totalAmount = computed(() =>
  filteredBills.value.reduce((s, b) => s + (Number(b.totalAmount) || 0), 0)
)
const pendingAmount = computed(() =>
  filteredBills.value
    .filter((b) => b.status !== 'verified')
    .reduce((s, b) => s + (Number(b.totalAmount) || 0), 0)
)

function onSelectCustomer(name) {
  selectedCustomer.value = name
  showFilter.value = false
}
</script>

<template>
  <div>
    <header class="wx-header">
      <div class="wx-header-title">
        <span>记账本</span>
        <button class="offline-badge" style="border:none;color:#fff;cursor:pointer;" @click="emit('openAuth')">{{ currentUser?.isLoggedIn ? '☁ ' + (currentUser.email || '已同步') : (isOnline ? '☁ 登录同步' : '离线模式') }}</button>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <button class="pill-btn" @click="showFilter = true">
          <span>{{ selectedCustomer || '全部客户' }}</span>
          <span>⊞</span>
        </button>
        <button class="pill-btn" style="background:rgba(255,255,255,0.28);font-weight:600;" @click="emit('openSmartImport')">
          <span>⚡ 智能批量导入</span>
        </button>
      </div>

      <div class="wx-summary-row">
        <input
          type="month"
          class="month-input"
          :value="month"
          @input="emit('update:month', $event.target.value)"
        />
        <div>
          <span>总账 ¥{{ formatMoney(totalAmount) }}</span>
          <span style="margin-left:10px;">未核销 ¥{{ formatMoney(pendingAmount) }}</span>
        </div>
      </div>
    </header>

    <div
      v-if="syncBanner"
      style="background:#FEF3C7;color:#92400E;padding:8px 14px;font-size:13px;display:flex;justify-content:space-between;align-items:center;"
    >
      <span>{{ syncBanner }}</span>
    </div>
    <div
      v-else-if="pendingSyncCount > 0"
      style="background:#FFF7ED;color:#C2410C;padding:8px 14px;font-size:13px;display:flex;justify-content:space-between;align-items:center;"
    >
      <span>有 {{ pendingSyncCount }} 条离线账单待上传云盘（联网后自动上传）</span>
      <button class="btn-sm primary" style="padding:3px 8px;font-size:12px;" @click="emit('openAuth')">去同步</button>
    </div>

    <div class="toolbar">
      <input v-model="keyword" class="search-input" placeholder="搜客户、类目、单号或备注..." />
      <select v-model="statusFilter" class="status-select">
        <option value="all">全部状态</option>
        <option value="pending">未核销</option>
        <option value="verified">已核销</option>
      </select>
    </div>

    <div v-if="filteredBills.length === 0" class="empty-state">
      <div style="font-size:32px;margin-bottom:8px;">📄</div>
      <div>{{ month }} 暂无账单记录</div>
      <div style="font-size:13px;margin-top:6px;">点右下角「记一笔」选择客户并按固定类目填数量</div>
    </div>

    <div v-else class="bill-list">
      <div v-for="bill in filteredBills" :key="bill.id" class="bill-card">
        <div class="bill-top">
          <div>
            <div class="bill-customer">
              {{ bill.customerName }}
              <span
                class="tag"
                :class="bill.status === 'verified' ? 'tag-verified' : 'tag-pending'"
                style="margin-left:6px;"
              >
                {{ bill.status === 'verified' ? '已核销' : '未核销' }}
              </span>
              <span
                v-if="bill.syncStatus === 'pending'"
                class="tag"
                style="background:#FEE2E2;color:#B91C1C;margin-left:4px;"
              >
                待上传云端
              </span>
            </div>
            <div class="bill-meta">{{ bill.date }} · {{ bill.billNo }} · {{ bill.paymentMethod }}</div>
          </div>
          <div class="bill-amount">¥{{ formatMoney(bill.totalAmount) }}</div>
        </div>

        <div class="bill-items-preview">
          <div v-for="(it, idx) in bill.items" :key="idx">
            {{ it.name }}：{{ it.qty }}{{ it.unit }} × ¥{{ it.price }} = <strong>¥{{ formatMoney(it.qty * it.price) }}</strong>
          </div>
          <div v-if="bill.remark" style="color:#6B7280;margin-top:4px;">备注：{{ bill.remark }}</div>
        </div>

        <div class="bill-actions">
          <button class="btn-sm primary" @click="emit('preview', bill)">电子单据</button>
          <button class="btn-sm" @click="emit('toggleVerify', bill)">
            {{ bill.status === 'verified' ? '撤回核销' : '核销' }}
          </button>
          <button
            v-if="bill.status !== 'verified'"
            class="btn-sm"
            @click="emit('edit', bill)"
          >
            编辑
          </button>
          <button
            v-else
            class="btn-sm"
            style="color:#B45309;border-color:#FCD34D;"
            @click="emit('openAdmin')"
          >
            管理员纠错
          </button>
          <button class="btn-sm danger" @click="emit('delete', bill)">删除</button>
        </div>
      </div>
    </div>

    <button class="fab-btn" @click="emit('create', selectedCustomer)">
      <span>✎</span>
      <span>记一笔</span>
    </button>

    <FilterDrawer
      :visible="showFilter"
      :customers="customers"
      :selected-customer="selectedCustomer"
      @close="showFilter = false"
      @select="onSelectCustomer"
    />
  </div>
</template>
