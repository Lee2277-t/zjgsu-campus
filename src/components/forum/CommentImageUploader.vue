<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { AlertCircle, ImagePlus, RotateCw, X } from 'lucide-vue-next'
import {
  COMMENT_IMAGE_ACCEPT_EXT,
  COMMENT_IMAGE_MAX_COUNT,
  COMMENT_IMAGE_MAX_SIZE,
  CommentImageError,
  uploadCommentImage,
  validateCommentImage,
  type UploadTask,
} from '@/services/comment'
import type { CommentImage } from '@/types'

const props = withDefaults(
  defineProps<{
    /** 已上传成功的图片，父组件随 v-model 同步 */
    modelValue: CommentImage[]
    /** 单次最多上传张数，默认 3（评论）；发帖配图可传 6 */
    max?: number
    disabled?: boolean
    /** 上传区下方的提示文案，留空使用默认提示 */
    hint?: string
  }>(),
  {
    max: COMMENT_IMAGE_MAX_COUNT,
    disabled: false,
    hint: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [images: CommentImage[]]
  /** 有图片上传失败时通知父组件，用于全局错误提示 */
  error: [message: string]
  /** 是否有图片正在上传：父组件据此禁用「发布」，避免图还没传完就提交 */
  'update:busy': [busy: boolean]
}>()

const inputRef = ref<HTMLInputElement | null>(null)
const tasks = ref<UploadTask[]>([])
let taskSequence = 0

const busy = computed(() => tasks.value.some((task) => task.status === 'uploading'))
watch(busy, (value) => emit('update:busy', value))

const maxSizeMb = Math.floor(COMMENT_IMAGE_MAX_SIZE / 1024 / 1024)
const defaultHint = `支持 JPG / PNG / WebP / GIF，单张不超过 ${maxSizeMb}MB，最多 ${props.max} 张`
const hintText = computed(() => props.hint || defaultHint)

/** 已成功 + 上传中的任务都占名额，达到上限后隐藏添加入口 */
const pendingCount = computed(
  () => props.modelValue.length + tasks.value.filter((task) => task.status !== 'error').length,
)
const canAddMore = computed(() => !props.disabled && pendingCount.value < props.max)

function openPicker() {
  if (!canAddMore.value) return
  inputRef.value?.click()
}

function createTask(file: File): UploadTask {
  taskSequence += 1
  return {
    id: `task-${Date.now()}-${taskSequence}`,
    file,
    status: 'uploading',
    progress: 0,
    // 上传中也要给缩略图预览：本地先建一份对象 URL，成功/失败/移除时统一回收
    localUrl: URL.createObjectURL(file),
  }
}

/** 失败的任务保留可重试；重新选图时先清掉旧的失败态：名额已让出，残留缩略图没有保留价值 */
function dropFailedTasks() {
  for (const task of tasks.value) {
    if (task.status === 'error' && task.localUrl) URL.revokeObjectURL(task.localUrl)
  }
  tasks.value = tasks.value.filter((task) => task.status !== 'error')
}

function onFilesPicked(event: Event) {
  const input = event.target as HTMLInputElement
  // FileList 是活引用：必须先把文件拷出来，再清 input 的 value。
  // 顺序反了的话，清 value 会把手里的这份一起清空（选完图什么都没发生）
  const files = Array.from(input.files || [])
  // 清空 value：不清的话同一文件第二次选择不会触发 change（值没变）
  input.value = ''
  void handleFiles(files)
}

async function handleFiles(files: File[]) {
  if (!files.length) return
  dropFailedTasks()
  // 每次只放行剩余名额内的文件，超出的直接提示，不进入上传队列
  const accepted = files.slice(0, Math.max(0, props.max - pendingCount.value))
  const rejected = files.length - accepted.length
  if (rejected > 0) {
    emit('error', `一次最多选 ${props.max} 张，多出的 ${rejected} 张已忽略`)
  }

  const queued: UploadTask[] = []
  for (const file of accepted) {
    try {
      await validateCommentImage(file, pendingCount.value + queued.length)
      queued.push(createTask(file))
    } catch (error) {
      const message =
        error instanceof CommentImageError ? error.message : '这张图片不符合要求，已跳过'
      emit('error', message)
    }
  }
  if (!queued.length) return
  tasks.value = [...tasks.value, ...queued]
  for (const task of queued) {
    void runUpload(task.id)
  }
}

async function runUpload(taskId: string) {
  const task = tasks.value.find((item) => item.id === taskId)
  if (!task || task.status === 'done') return
  task.status = 'uploading'
  task.progress = 0
  task.error = undefined
  task.errorCode = undefined

  try {
    const image = await uploadCommentImage(task.file, (percent) => {
      task.progress = percent
    })
    task.image = image
    task.status = 'done'
    emit('update:modelValue', [...props.modelValue, image])
    // 成功的任务立刻从队列撤掉，缩略图改由 modelValue 渲染
    tasks.value = tasks.value.filter((item) => item.id !== taskId)
  } catch (error) {
    task.status = 'error'
    task.progress = 0
    if (error instanceof CommentImageError) {
      task.error = error.message
      task.errorCode = error.code
    } else {
      task.error = '上传失败，请重试'
      task.errorCode = 'network'
    }
  }
}

function retryTask(taskId: string) {
  // 只重试这一张：其他失败任务留着，用户可能还想单独重试它们
  void runUpload(taskId)
}

function removeTask(taskId: string) {
  const task = tasks.value.find((item) => item.id === taskId)
  if (task?.localUrl) URL.revokeObjectURL(task.localUrl)
  if (task?.image) URL.revokeObjectURL(task.image.url)
  tasks.value = tasks.value.filter((item) => item.id !== taskId)
}

function removeImage(imageId: string) {
  const image = props.modelValue.find((item) => item.id === imageId)
  if (image) URL.revokeObjectURL(image.url)
  emit(
    'update:modelValue',
    props.modelValue.filter((item) => item.id !== imageId),
  )
}

function previewUrl(task: UploadTask) {
  return task.image?.url || task.localUrl
}

function formatSize(bytes?: number) {
  if (!bytes) return ''
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap gap-2">
      <!-- 已上传成功的缩略图 -->
      <div
        v-for="image in modelValue"
        :key="image.id"
        class="group relative h-20 w-20 shrink-0 overflow-hidden rounded-inner border border-line bg-slate-50"
      >
        <img :src="image.url" alt="评论配图" class="h-full w-full object-cover" />
        <button
          type="button"
          class="focus-ring absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-slate-900/55 text-white transition hover:bg-slate-900/75"
          :aria-label="`移除图片 ${image.name || ''}`"
          @click="removeImage(image.id)"
        >
          <X :size="13" />
        </button>
      </div>

      <!-- 上传中 / 失败的任务 -->
      <div
        v-for="task in tasks"
        :key="task.id"
        class="relative h-20 w-20 shrink-0 overflow-hidden rounded-inner border bg-slate-50"
        :class="task.status === 'error' ? 'border-danger' : 'border-line'"
      >
        <img :src="previewUrl(task)" alt="" class="h-full w-full object-cover" />

        <!-- 加载态：半透明遮罩 + 进度百分比 -->
        <div
          v-if="task.status === 'uploading'"
          class="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/45 text-white"
        >
          <span class="text-xs font-semibold">{{ task.progress }}%</span>
          <div class="mt-1.5 h-1 w-12 overflow-hidden rounded-full bg-white/30">
            <div
              class="h-full rounded-full bg-white transition-all duration-200"
              :style="{ width: `${task.progress}%` }"
            />
          </div>
        </div>

        <!-- 失败态：错误图标 + 重试 + 移除 -->
        <div
          v-else-if="task.status === 'error'"
          class="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-dangerSoft/95 px-1 text-center"
        >
          <AlertCircle :size="15" class="text-danger" />
          <span class="text-[9px] leading-3 text-danger">上传失败</span>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="focus-ring flex h-6 w-6 items-center justify-center rounded-full bg-white text-danger shadow-sm"
              aria-label="重试上传"
              @click="retryTask(task.id)"
            >
              <RotateCw :size="12" />
            </button>
            <button
              type="button"
              class="focus-ring flex h-6 w-6 items-center justify-center rounded-full bg-white text-muted shadow-sm"
              aria-label="移除图片"
              @click="removeTask(task.id)"
            >
              <X :size="12" />
            </button>
          </div>
        </div>
      </div>

      <!-- 添加图片入口 -->
      <button
        v-if="canAddMore"
        type="button"
        class="focus-ring pressable flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1.5 rounded-inner border border-dashed border-slate-300 bg-slate-50 text-[11px] text-faint transition hover:border-brand-300 hover:text-brand-500"
        @click="openPicker"
      >
        <ImagePlus :size="20" />
        添加图片
      </button>
    </div>

    <p class="text-[11px] text-faint">{{ hintText }}</p>

    <input
      ref="inputRef"
      type="file"
      class="hidden"
      :accept="COMMENT_IMAGE_ACCEPT_EXT"
      multiple
      @change="onFilesPicked"
    />
  </div>
</template>
