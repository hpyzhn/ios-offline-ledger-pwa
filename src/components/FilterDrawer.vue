<script setup>
defineProps({
  visible: Boolean,
  customers: Array,
  selectedCustomer: String
})

const emit = defineEmits(['close', 'select'])
</script>

<template>
  <div v-if="visible" class="modal-mask" @click.self="emit('close')">
    <div class="modal-sheet">
      <div class="modal-header">
        <button class="btn-sm" @click="emit('close')">取消</button>
        <span>选择合作商家 / 客户</span>
        <span style="width: 44px;"></span>
      </div>
      <div class="modal-body">
        <button
          class="btn-block"
          :class="selectedCustomer === '' ? 'btn-primary' : 'btn-secondary'"
          style="margin-bottom: 14px; width: 100%;"
          @click="emit('select', '')"
        >
          全部客户
        </button>
        <div class="form-label">按客户筛选账单</div>
        <div class="grid-3">
          <button
            v-for="c in customers"
            :key="c.id"
            class="btn-sm"
            style="padding: 12px 6px; font-size: 14px;"
            :style="selectedCustomer === c.name ? 'background:#E8F8F0;border-color:#2EB872;color:#259B5E;font-weight:600;' : ''"
            @click="emit('select', c.name)"
          >
            {{ c.name }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
