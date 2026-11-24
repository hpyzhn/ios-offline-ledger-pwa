<script setup>
import { computed } from 'vue'
import { numberToChineseRMB, formatMoney } from '../utils/rmb'
import { allocateBillCents } from '../utils/money.js'

const props = defineProps({
  visible: Boolean,
  bill: Object,
  settings: Object
})

const amounts = computed(() => allocateBillCents(props.bill?.items || [], props.bill?.totalAmount))
const emit = defineEmits(['close', 'toggleVerify'])

// Vue 模板无法直接访问 window，需通过 setup 暴露的方法调用打印
function printReceipt() {
  if (typeof window !== 'undefined' && typeof window.print === 'function') window.print()
}
</script>

<template>
  <div v-if="visible && bill" class="modal-mask" @click.self="emit('close')">
    <div class="modal-sheet">
      <div class="modal-header no-print">
        <button class="btn-sm" @click="emit('close')">关闭</button>
        <span>电子单据（可截屏发客户核销）</span>
        <button class="btn-sm primary" @click="printReceipt">打印</button>
      </div>

      <div class="modal-body">
        <div class="receipt-paper">
          <div class="receipt-title">{{ settings?.companyName || '电子出库 / 收款单' }}</div>
          <div class="receipt-no">{{ bill.billNo }}</div>

          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px;flex-wrap:wrap;gap:6px;">
            <span><strong>客户：</strong>{{ bill.customerName }}</span>
            <span><strong>日期：</strong>{{ bill.date }}</span>
          </div>

          <table class="receipt-table">
            <thead>
              <tr>
                <th>类目名称</th>
                <th>单位</th>
                <th>数量</th>
                <th>单价</th>
                <th>金额(元)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(item, idx) in bill.items" :key="idx">
                <td>{{ item.name }}</td>
                <td>{{ item.unit }}</td>
                <td class="num">{{ item.qty }}</td>
                <td class="num">{{ formatMoney(item.price) }}</td>
                <td class="num">{{ formatMoney(amounts[idx] / 100) }}</td>
              </tr>
            </tbody>
          </table>

          <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:12px;flex-wrap:wrap;gap:6px;">
            <span><strong>合计(大写)：</strong>{{ numberToChineseRMB(bill.totalAmount) }}</span>
            <span><strong>小写：¥{{ formatMoney(bill.totalAmount) }}</strong></span>
          </div>

          <div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:1px dashed #9CA3AF;font-size:12px;flex-wrap:wrap;gap:6px;">
            <span>方式：{{ bill.paymentMethod }}</span>
            <span>经手人：{{ settings?.handlerName || '-' }}</span>
            <span :style="bill.status === 'verified' ? 'color:#259B5E;font-weight:700;' : 'color:#B45309;font-weight:700;'">
              {{ bill.status === 'verified' ? '【已核销】' : '【未核销】' }}
            </span>
          </div>
          <div v-if="bill.remark" style="margin-top:6px;font-size:12px;color:#4B5563;">备注：{{ bill.remark }}</div>
        </div>
      </div>

      <div class="modal-footer no-print">
        <button class="btn-block btn-secondary" @click="emit('toggleVerify', bill)">
          {{ bill.status === 'verified' ? '撤回为未核销' : '标记为已核销' }}
        </button>
        <button class="btn-block btn-primary" @click="emit('close')">完成</button>
      </div>
    </div>
  </div>
</template>
