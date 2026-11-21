<template>
  <BaseCard>
    <div class="flex items-center gap-2">
      <MessageCircle :size="17" class="text-brand-500" />
      <h2 class="text-sm font-semibold text-ink">讨论 {{ comments.length }}</h2>
      <div class="ml-auto flex rounded-full bg-slate-100 p-1">
        <button
          type="button"
          class="min-h-8 rounded-full px-3 text-[11px] font-medium"
          :class="commentSort === 'latest' ? 'bg-white text-brand-600 shadow-sm' : 'text-muted'"
          @click="commentSort = 'latest'"
        >
          最新
        </button>
        <button
          type="button"
          class="min-h-8 rounded-full px-3 text-[11px] font-medium"
          :class="commentSort === 'hot' ? 'bg-white text-brand-600 shadow-sm' : 'text-muted'"
          @click="commentSort = 'hot'"
        >
          最热
        </button>
      </div>
    </div>

    <!-- 发布框：文字与配图至少有一项才可发布；仍有图在上传时禁用发布 -->
    <div class="mt-3 rounded-inner border border-line bg-slate-50 p-3">
      <label class="block">
        <span class="sr-only">评论内容</span>
        <textarea
          v-model="commentDraft"
          rows="2"
          maxlength="300"
          placeholder="友善评论，理性发言，也可以带图说明…"
          class="w-full resize-none bg-transparent text-sm leading-6 text-ink outline-none placeholder:text-faint"
        />
      </label>
      <div class="mt-1 text-right text-[11px] text-faint">{{ commentDraft.length }}/300</div>
      <CommentImageUploader
        v-model="commentImages"
        :max="3"
        @error="commentError = $event"
        @update:busy="uploaderBusy = $event"
      />
      <div class="mt-2 flex items-center justify-end gap-2">
        <span v-if="commentError" class="mr-auto text-[11px] leading-4 text-danger">{{ commentError }}</span>
        <span v-else-if="uploaderBusy" class="mr-auto text-[11px] text-faint">图片上传中，稍候即可发布…</span>
        <BaseButton
          size="sm"
          :disabled="!canPublishComment"
          :loading="commentSubmitting"
          @click="publishComment"
        >
          <Send v-if="!commentSubmitting" :size="15" />
          发布评论
        </BaseButton>
      </div>
    </div>

    <div class="mt-3 divide-y divide-line/70">
      <article
        v-for="comment in sortedComments"
        :key="comment.id"
        class="py-3 first:pt-1 last:pb-0"
      >
        <div v-if="pinnedId === comment.id" class="mb-2 flex items-center gap-1 text-[11px] font-medium text-brand-600">
          <Pin :size="13" fill="currentColor" />
          楼主置顶
        </div>
        <div class="flex items-start gap-3">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-forumSoft text-xs font-semibold text-forum">
            {{ comment.author.slice(0, 1) }}
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-xs font-medium text-ink">{{ comment.author }}</span>
              <span class="text-[10px] text-faint">{{ comment.time }}</span>
            </div>
            <p class="mt-1.5 text-sm leading-6 text-slate-600">{{ comment.content }}</p>
            <!-- 配图网格：1 / 2 / 3 张各自一套宽度，点击进全屏预览 -->
            <div
              v-if="comment.images && comment.images.length > 0"
              class="mt-2 grid gap-1.5"
              :class="
                comment.images.length === 1
                  ? 'max-w-[52%] grid-cols-1'
                  : comment.images.length === 2
                    ? 'max-w-[70%] grid-cols-2'
                    : 'max-w-[86%] grid-cols-3'
              "
            >
              <button
                v-for="(image, imageIndex) in comment.images"
                :key="image.id"
                type="button"
                class="focus-ring overflow-hidden rounded-inner border border-line bg-slate-50 transition active:scale-[0.97]"
                :aria-label="`查看评论图片第 ${imageIndex + 1} 张`"
                @click="openViewer(comment.images!, imageIndex)"
              >
                <img :src="image.url" alt="评论配图" class="aspect-square w-full object-cover" />
              </button>
            </div>
            <div class="mt-2 flex items-center gap-3 text-[11px] text-faint">
              <button type="button" class="flex min-h-8 items-center gap-1">
                <ThumbsUp :size="13" />
                {{ comment.likes }}
              </button>
              <button
                type="button"
                class="flex min-h-8 items-center gap-1 text-brand-600"
                @click="togglePin(comment.id)"
              >
                <Pin :size="13" />
                {{ pinnedId === comment.id ? '取消置顶' : '置顶评论' }}
              </button>
            </div>
          </div>
        </div>
      </article>
    </div>

    <CommentImageViewer
      :open="viewerOpen"
      :images="viewerImages"
      :initial-index="viewerIndex"
      @close="viewerOpen = false"
    />
  </BaseCard>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { MessageCircle, Pin, Send, ThumbsUp } from 'lucide-vue-next'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import CommentImageUploader from '@/components/forum/CommentImageUploader.vue'
import CommentImageViewer from '@/components/forum/CommentImageViewer.vue'
import { COMMENT_API_ENABLED } from '@/config/app'
import { seedComments } from '@/data/mock'
import { submitComment } from '@/services/comment'
import type { Comment, CommentImage } from '@/types'

const props = defineProps<{
  /** 所属帖子 id：提交评论时一并带给服务端 */
  postId: string
}>()

/* ---------------- 评论列表 ---------------- */

// 拷贝一份再初始化：直接引用 mock 数组的话，unshift 会改到模块级数据
const comments = ref<Comment[]>(seedComments.map((comment) => ({ ...comment })))
const commentSort = ref<'latest' | 'hot'>('latest')
const pinnedId = ref('comment-2')

const sortedComments = computed(() => {
  const list = [...comments.value]
  if (commentSort.value === 'hot') list.sort((a, b) => b.likes - a.likes)
  // 置顶始终排最前（sort 在稳定排序下保留上一轮的次序）
  return list.sort((a, b) => Number(b.id === pinnedId.value) - Number(a.id === pinnedId.value))
})

function togglePin(id: string) {
  pinnedId.value = pinnedId.value === id ? '' : id
}

/* ---------------- 发布评论（含配图） ---------------- */

const commentDraft = ref('')
const commentImages = ref<CommentImage[]>([])
const commentSubmitting = ref(false)
const uploaderBusy = ref(false)
const commentError = ref('')

const canPublishComment = computed(() => {
  if (commentSubmitting.value || uploaderBusy.value) return false
  return commentDraft.value.trim().length > 0 || commentImages.value.length > 0
})

async function publishComment() {
  if (!canPublishComment.value) return
  const text = commentDraft.value.trim()
  const images = commentImages.value
  commentSubmitting.value = true
  commentError.value = ''
  try {
    if (COMMENT_API_ENABLED) {
      const result = await submitComment({ postId: props.postId, content: text, images })
      if (result?.comment) {
        comments.value.unshift(result.comment)
      }
    } else {
      // 原型模式：本地落地一条评论，图片直接引用已上传成功的对象 URL
      comments.value.unshift({
        id: `comment-${Date.now()}`,
        author: '浙小商',
        content: text,
        time: '刚刚',
        likes: 0,
        images: images.length ? images : undefined,
      })
    }
    commentDraft.value = ''
    commentImages.value = []
  } catch {
    commentError.value = '评论没发出去，请重试'
  } finally {
    commentSubmitting.value = false
  }
}

/* ---------------- 配图全屏预览 ---------------- */

const viewerOpen = ref(false)
const viewerImages = ref<CommentImage[]>([])
const viewerIndex = ref(0)

function openViewer(images: CommentImage[], index: number) {
  viewerImages.value = images
  viewerIndex.value = index
  viewerOpen.value = true
}
</script>
