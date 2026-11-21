<script setup>
import { ref, watch } from 'vue'
import { createDefaultExportTemplate } from '../db/database'

const props = defineProps({
  visible: Boolean,
  customer: Object,
  defaultTitle: String
})

const emit = defineEmits(['close', 'save'])

const draft = ref(createDefaultExportTemplate())
const newColLabel = ref('')
const newColDefault = ref('')
const newStatusLabel = ref('')
const newStatusValue = ref('')

watch(
  () => props.visible,
  (open) => {
    if (!open || !props.customer) return
    const src = props.customer.exportTemplate || createDefaultExportTemplate(props.defaultTitle)
    draft.value = JSON.parse(JSON.stringify(src))
    if (!Array.isArray(draft.value.tailColumns)) {
      draft.value.tailColumns = createDefaultExportTemplate(props.defaultTitle).tailColumns
    }
    if (!Array.isArray(draft.value.extraStatusFields)) {
      draft.value.extraStatusFields = []
    }
  }
)

function moveCol(idx, delta) {
  const target = idx + delta
  const list = draft.value.tailColumns
  if (target < 0 || target >= list.length) return
  const temp = list[idx]
  list[idx] = list[target]
  list[target] = temp
}

function addCustomColumn() {
  const label = newColLabel.value.trim()
  if (!label) return alert('请输入新栏目名称')
  draft.value.tailColumns.push({
    key: 'custom_' + Date.now(),
    label,
    enabled: true,
    builtIn: false,
    defaultValue: newColDefault.value.trim()
  })
  newColLabel.value = ''
  newColDefault.value = ''
}

function removeCol(idx) {
  draft.value.tailColumns.splice(idx, 1)
}

function addStatusField() {
  const label = newStatusLabel.value.trim()
  if (!label) return alert('请输入底部栏目名，如：签收人 / 付款状态')
  draft.value.extraStatusFields.push({
    label,
    value: newStatusValue.value.trim()
  })
  newStatusLabel.value = ''
  newStatusValue.value = ''
}

function removeStatusField(idx) {
  draft.value.extraStatusFields.splice(idx, 1)
}

function resetToDefault() {
  draft.value = createDefaultExportTemplate(props.defaultTitle)
}

function handleSave() {
  emit('save', {
    customerId: props.customer.id,
    exportTemplate: JSON.parse(JSON.stringify(draft.value))
  })
}
</script>

<template>
  <div v-if="visible && customer" class="modal-mask" @click.self="emit('close')">
    <div class="modal-sheet">
      <div class="modal-header">
        <button class="btn-sm" @click="emit('close')">取消</button>
        <span>定制「{{ customer.name }}」输出表格</span>
        <button class="btn-sm" @click="resetToDefault">恢复原版格式</button>
      </div>

      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">结算表顶部标题（K1:AG1）</label>
          <input v-model="draft.sheetTitle" class="form-control" placeholder="广州市羽洁洗涤厂结算表" />
        </div>

        <div class="form-group">
          <label class="form-label">导出账单状态范围</label>
          <select v-model="draft.statusFilter" class="form-control">
            <option value="all">全部账单（已核销 + 未核销）</option>
            <option value="verified">仅导出已核销账单</option>
            <option value="pending">仅导出未核销账单</option>
          </select>
        </div>

        <div class="switch-row">
          <span>右上角显示月底结算日期（m/d/yyyy）</span>
          <input v-model="draft.showDate" type="checkbox" />
        </div>
        <div class="switch-row">
          <span>保留本月数量为 0 的固定类目行（如窗帘）</span>
          <input v-model="draft.includeZeroRows" type="checkbox" />
        </div>
        <div class="switch-row">
          <span>第 17 行 AJ17 自动生成总计公式</span>
          <input v-model="draft.includeTotalRow" type="checkbox" />
        </div>
        <div class="switch-row">
          <span>总计行左侧显示“合计”文字（原版留空）</span>
          <input v-model="draft.showTotalLabel" type="checkbox" />
        </div>
        <div class="switch-row">
          <span>额外附带「每笔交易明细」工作表（原版关闭）</span>
          <input v-model="draft.includeDetailSheet" type="checkbox" />
        </div>

        <div style="margin-top:16px;">
          <div style="font-weight:600;margin-bottom:8px;">尾部统计与自定义栏目（在 1~31 日之后）</div>
          <div
            v-for="(col, idx) in draft.tailColumns"
            :key="col.key"
            style="display:flex;align-items:center;gap:8px;padding:7px 8px;border:1px solid #EAECEF;border-radius:8px;margin-bottom:6px;background:#FAFAFA;"
          >
            <input v-model="col.enabled" type="checkbox" />
            <input v-model="col.label" class="form-control" style="padding:5px 8px;flex:1;" />
            <button class="btn-sm" type="button" @click="moveCol(idx, -1)">↑</button>
            <button class="btn-sm" type="button" @click="moveCol(idx, 1)">↓</button>
            <button v-if="!col.builtIn" class="btn-sm danger" type="button" @click="removeCol(idx)">删</button>
          </div>

          <div style="display:flex;gap:6px;margin-top:8px;">
            <input v-model="newColLabel" class="form-control" placeholder="新增栏目名（如：返洗数/扣款）" style="flex:1.2;" />
            <input v-model="newColDefault" class="form-control" placeholder="默认填值(选填)" style="flex:1;" />
            <button class="btn-sm primary" type="button" @click="addCustomColumn">+ 加列</button>
          </div>
        </div>

        <div style="margin-top:18px;">
          <div style="font-weight:600;margin-bottom:8px;">底部自定义状态 / 签字栏</div>
          <div
            v-for="(f, idx) in draft.extraStatusFields"
            :key="idx"
            style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"
          >
            <input v-model="f.label" class="form-control" placeholder="栏目名" style="flex:1;" />
            <input v-model="f.value" class="form-control" placeholder="内容（留空则打印后手填）" style="flex:1.3;" />
            <button class="btn-sm danger" type="button" @click="removeStatusField(idx)">删</button>
          </div>
          <div style="display:flex;gap:6px;">
            <input v-model="newStatusLabel" class="form-control" placeholder="如：客户签字 / 结款状态" style="flex:1;" />
            <input v-model="newStatusValue" class="form-control" placeholder="默认内容(可留空)" style="flex:1;" />
            <button class="btn-sm primary" type="button" @click="addStatusField">+ 加行</button>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn-block btn-primary" @click="handleSave">保存为「{{ customer.name }}」专属输出格式</button>
      </div>
    </div>
  </div>
</template>
