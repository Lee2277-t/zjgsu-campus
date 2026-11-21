<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, LoaderCircle, X } from 'lucide-vue-next'
import type { CommentImage } from '@/types'

const props = defineProps<{
  open: boolean
  images: CommentImage[]
  /** 打开时定位到第几张，从 0 开始 */
  initialIndex?: number
}>()

const emit = defineEmits<{
  close: []
}>()

const current = ref(0)
const loaded = ref<Record<string, boolean>>({})
const touchStartX = ref<number | null>(null)

const currentImage = computed(() => props.images[current.value] || null)
const hasMultiple = computed(() => props.images.length > 1)

watch(
  () => props.open,
  (open) => {
    if (open) {
      current.value = Math.min(Math.max(0, props.initialIndex ?? 0), props.images.length - 1)
      loaded.value = {}
    }
    // 预览打开时锁住背景滚动：否则背后的话题页会跟着手势一起滚，关掉后位置全乱
    document.body.style.overflow = open ? 'hidden' : ''
  },
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})

function go(offset: number) {
  if (!hasMultiple.value) return
  const total = props.images.length
  current.value = (current.value + offset + total) % total
}

function onKeydown(event: KeyboardEvent) {
  if (!props.open) return
  if (event.key === 'Escape') emit('close')
  else if (event.key === 'ArrowLeft') go(-1)
  else if (event.key === 'ArrowRight') go(1)
}

function onTouchStart(event: TouchEvent) {
  touchStartX.value = event.touches[0]?.clientX ?? null
}

function onTouchEnd(event: TouchEvent) {
  const start = touchStartX.value
  touchStartX.value = null
  if (start === null) return
  const delta = (event.changedTouches[0]?.clientX ?? start) - start
  // 横向滑动超过 48px 才翻页，避免与纵向滚动手势打架
  if (delta <= -48) go(1)
  else if (delta >= 48) go(-1)
}

onMounted(() => window.addEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open && currentImage"
        class="fixed inset-0 z-[100] flex flex-col bg-slate-950/90"
        role="dialog"
        aria-modal="true"
        aria-label="评论图片预览"
        @click.self="emit('close')"
        @touchstart.passive="onTouchStart"
        @touchend.passive="onTouchEnd"
      >
        <!-- 顶部栏：计数 + 关闭 -->
        <header class="flex items-center justify-between px-4 py-3 text-white">
          <span class="text-xs text-white/70">
            {{ hasMultiple ? `${current + 1} / ${images.length}` : '评论配图' }}
          </span>
          <button
            type="button"
            class="focus-ring flex h-10 w-10 items-center justify-center rounded-full text-white/85 transition hover:bg-white/10"
            aria-label="关闭预览"
            @click="emit('close')"
          >
            <X :size="22" />
          </button>
        </header>

        <!-- 图片区：点击图片本身不关闭（避免误触），左右空白点击关闭 -->
        <div class="relative flex flex-1 items-center justify-center overflow-hidden px-2">
          <img
            :key="currentImage.id"
            :src="currentImage.url"
            :alt="currentImage.name || '评论配图'"
            class="max-h-full max-w-full object-contain"
            :class="loaded[currentImage.id] ? 'opacity-100' : 'opacity-0'"
            @load="loaded[currentImage.id] = true"
          />
          <div
            v-if="!loaded[currentImage.id]"
            class="absolute inset-0 flex items-center justify-center text-white/60"
          >
            <LoaderCircle :size="28" class="animate-spin" />
          </div>

          <button
            v-if="hasMultiple"
            type="button"
            class="focus-ring absolute left-2 flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm transition hover:bg-white/20"
            aria-label="上一张"
            @click="go(-1)"
          >
            <ChevronLeft :size="24" />
          </button>
          <button
            v-if="hasMultiple"
            type="button"
            class="focus-ring absolute right-2 flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm transition hover:bg-white/20"
            aria-label="下一张"
            @click="go(1)"
          >
            <ChevronRight :size="24" />
          </button>
        </div>

        <!-- 底部：缩略图条（多图时），点击直接跳转 -->
        <footer v-if="hasMultiple" class="flex justify-center gap-2 px-4 pb-6 pt-3">
          <button
            v-for="(image, index) in images"
            :key="image.id"
            type="button"
            class="focus-ring h-12 w-12 shrink-0 overflow-hidden rounded-inner border-2 transition"
            :class="index === current ? 'border-white' : 'border-transparent opacity-60'"
            :aria-label="`查看第 ${index + 1} 张`"
            @click="current = index"
          >
            <img :src="image.url" alt="" class="h-full w-full object-cover" />
          </button>
        </footer>
      </div>
    </Transition>
  </Teleport>
</template>
