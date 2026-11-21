<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  customers: Array,
  products: Array,
  settings: Object,
  currentUser: Object
})

const emit = defineEmits([
  'addCustomer',
  'updateCustomerCategories',
  'deleteCustomer',
  'addProduct',
  'deleteProduct',
  'saveSettings',
  'backupJson',
  'restoreJson',
  'openAuth',
  'openAdmin',
  'openSmartImport'
])

// 新增合作客户
const newCustomerName = ref('')
const activeCustId = ref(null)

// 为当前选中客户新增固定类目
const catName = ref('')
const catPrice = ref(1.0)
const catUnit = ref('条')

// 全局抬头配置
const companyName = ref('')
const handlerName = ref('')

watch(
  () => props.customers,
  (list) => {
    if (list?.length && !list.some((c) => c.id === activeCustId.value)) {
      activeCustId.value = list[0].id
    }
  },
  { immediate: true }
)

watch(
  () => props.settings,
  (val) => {
    if (!val) return
    companyName.value = val.companyName || ''
    handlerName.value = val.handlerName || ''
  },
  { immediate: true }
)

const activeCustomer = computed(() =>
  (props.customers || []).find((c) => c.id === activeCustId.value) || null
)

function handleCreateCustomer() {
  const name = newCustomerName.value.trim()
  if (!name) return alert('请输入合作商家/客户名称')
  emit('addCustomer', name)
  newCustomerName.value = ''
}

function addCategoryToCustomer() {
  if (!activeCustomer.value) return
  const name = catName.value.trim()
  if (!name) return alert('请输入类目名称')
  const list = JSON.parse(JSON.stringify(activeCustomer.value.categories || []))
  if (list.some((c) => c.name === name)) return alert('该客户已存在同名类目')
  list.push({ name, unit: catUnit.value.trim() || '条', price: Number(catPrice.value) || 0, enabled: true })
  emit('updateCustomerCategories', { customerId: activeCustomer.value.id, categories: list })
  catName.value = ''
  catPrice.value = 1.0
}

function updateCategoryPrice(idx, price) {
  const list = JSON.parse(JSON.stringify(activeCustomer.value.categories || []))
  list[idx].price = Number(price) || 0
  emit('updateCustomerCategories', { customerId: activeCustomer.value.id, categories: list })
}

function moveCategory(idx, delta) {
  const list = JSON.parse(JSON.stringify(activeCustomer.value.categories || []))
  const t = idx + delta
  if (t < 0 || t >= list.length) return
  const tmp = list[idx]
  list[idx] = list[t]
  list[t] = tmp
  emit('updateCustomerCategories', { customerId: activeCustomer.value.id, categories: list })
}

function removeCategoryFromCustomer(idx) {
  const list = JSON.parse(JSON.stringify(activeCustomer.value.categories || []))
  list.splice(idx, 1)
  emit('updateCustomerCategories', { customerId: activeCustomer.value.id, categories: list })
}

function handleSaveProfile() {
  emit('saveSettings', {
    companyName: companyName.value.trim() || '广州市羽洁洗涤厂结算表',
    handlerName: handlerName.value.trim() || '经手人'
  })
  alert('默认结算表抬头已保存')
}

function onFileChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    emit('restoreJson', reader.result)
    e.target.value = ''
  }
  reader.readAsText(file)
}
</script>

<template>
  <div>
    <header class="wx-header">
      <div class="wx-header-title" style="margin:0;">客户、固定类目与后台设置</div>
    </header>

    <div style="padding: 12px; display: flex; flex-direction: column; gap: 12px;">
      <!-- 0. 云端账号与多设备同步 -->
      <div class="bill-card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div>
          <div style="font-weight:600;">云端账号同步（Dexie Cloud）</div>
          <div style="font-size:12px;color:#7F848A;margin-top:2px;">
            {{ currentUser?.isLoggedIn ? '已登录：' + (currentUser.email || currentUser.userId) : '未登录（点击登录实现手机/电脑多端同步）' }}
          </div>
        </div>
        <button class="btn-sm primary" style="white-space:nowrap;" @click="emit('openAuth')">
          {{ currentUser?.isLoggedIn ? '同步管理' : '登录 / 配置' }}
        </button>
      </div>

      <!-- 0.5 管理员后台（错单数量与价格纠错权限） -->
      <div class="bill-card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;border-left:4px solid #F59E0B;">
        <div>
          <div style="font-weight:600;">管理员后台（订单纠错与日志）</div>
          <div style="font-size:12px;color:#7F848A;margin-top:2px;">
            修正因输错导致的数量/单价异常订单（含已核销锁单），自动留存审计日志
          </div>
        </div>
        <button class="btn-sm primary" style="white-space:nowrap;" @click="emit('openAdmin')">
          进入后台
        </button>
      </div>

      <!-- 0.8 智能批量导入多客户数据 -->
      <div class="bill-card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;border-left:4px solid #2EB872;">
        <div>
          <div style="font-weight:600;">智能批量导入（多客户文本识别）</div>
          <div style="font-size:12px;color:#7F848A;margin-top:2px;">
            仿快递粘贴识别，一次导入多个客户每日数量，自动建档并入库
          </div>
        </div>
        <button class="btn-sm primary" style="white-space:nowrap;" @click="emit('openSmartImport')">
          去导入
        </button>
      </div>

      <!-- 1. 合作商家/客户管理 -->
      <div class="bill-card">
        <div style="font-weight:600;margin-bottom:8px;">合作商家 / 客户管理</div>
        <div style="display:flex;gap:8px;margin-bottom:10px;">
          <input v-model="newCustomerName" class="form-control" placeholder="新增商家名，如：餐厅B / XX酒店" />
          <button class="btn-sm primary" style="white-space:nowrap;padding:0 14px;" @click="handleCreateCustomer">+ 新增</button>
        </div>

        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button
            v-for="c in customers"
            :key="c.id"
            class="btn-sm"
            :class="activeCustId === c.id ? 'primary' : ''"
            :style="activeCustId === c.id ? 'background:#E8F8F0;font-weight:600;' : ''"
            @click="activeCustId = c.id"
          >
            {{ c.name }}
          </button>
        </div>
      </div>

      <!-- 2. 当前客户的固定类目与专属单价（增删改查 + 排序） -->
      <div v-if="activeCustomer" class="bill-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <strong>「{{ activeCustomer.name }}」固定预输入类目</strong>
          <button
            v-if="customers.length > 1"
            class="btn-sm danger"
            @click="emit('deleteCustomer', activeCustomer)"
          >
            删除该客户
          </button>
        </div>

        <div class="grid-3" style="margin-bottom:8px;">
          <input v-model="catName" class="form-control" placeholder="类目名(如台布)" />
          <input v-model.number="catPrice" type="number" step="any" class="form-control" placeholder="单价" />
          <input v-model="catUnit" class="form-control" placeholder="单位(条/个)" />
        </div>
        <button class="btn-block btn-primary" style="width:100%;margin-bottom:12px;" @click="addCategoryToCustomer">
          + 添加到「{{ activeCustomer.name }}」固定类目
        </button>

        <div
          v-for="(cat, idx) in activeCustomer.categories"
          :key="cat.name"
          style="display:flex;align-items:center;gap:6px;padding:8px 0;border-bottom:1px solid #F3F4F6;"
        >
          <div style="flex:1.2;font-weight:600;">{{ cat.name }} <span style="font-weight:400;color:#7F848A;font-size:12px;">({{ cat.unit }})</span></div>
          <input
            type="number"
            step="any"
            class="form-control"
            style="width:78px;padding:5px 6px;"
            :value="cat.price"
            @change="updateCategoryPrice(idx, $event.target.value)"
          />
          <button class="btn-sm" @click="moveCategory(idx, -1)">↑</button>
          <button class="btn-sm" @click="moveCategory(idx, 1)">↓</button>
          <button class="btn-sm danger" @click="removeCategoryFromCustomer(idx)">删</button>
        </div>
      </div>

      <!-- 3. 默认结算表抬头设置 -->
      <div class="bill-card">
        <div style="font-weight:600;margin-bottom:8px;">默认结算表抬头</div>
        <div class="form-group">
          <label class="form-label">厂名 / 结算表主标题</label>
          <input v-model="companyName" class="form-control" />
        </div>
        <div class="form-group">
          <label class="form-label">默认经手人</label>
          <input v-model="handlerName" class="form-control" />
        </div>
        <button class="btn-block btn-secondary" style="width:100%;" @click="handleSaveProfile">保存设置</button>
      </div>

      <!-- 4. 本地数据备份与恢复 -->
      <div class="bill-card">
        <div style="font-weight:600;margin-bottom:6px;">本地离线数据备份</div>
        <div style="font-size:13px;color:#7F848A;margin-bottom:10px;">
          导出 JSON 包含全部客户、专属输出模板、固定类目和历史账单，换手机可一键恢复。
        </div>
        <div style="display:flex;gap:10px;">
          <button class="btn-block btn-secondary" @click="emit('backupJson')">导出 JSON 备份</button>
          <label class="btn-block btn-secondary" style="text-align:center;display:block;">
            导入恢复
            <input type="file" accept="application/json" style="display:none;" @change="onFileChange" />
          </label>
        </div>
      </div>
    </div>
  </div>
</template>
