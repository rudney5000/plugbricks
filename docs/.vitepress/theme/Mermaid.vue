<script setup lang="ts">
// A ```mermaid block of the documents, drawn in the browser (GitHub draws the same blocks by itself).
import { useData } from "vitepress";
import { onMounted, ref, watch } from "vue";

const props = defineProps<{ code: string }>();
const { isDark } = useData();
const svg = ref("");
let count = 0;

async function draw() {
  // Loaded only on a page that has a diagram.
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: isDark.value ? "dark" : "default",
    // A wide diagram keeps its size and scrolls, rather than shrinking until its text cannot be read.
    flowchart: { useMaxWidth: false },
    sequence: { useMaxWidth: false },
  });
  const id = `mermaid-${Math.random().toString(36).slice(2)}-${count++}`;
  svg.value = (await mermaid.render(id, decodeURIComponent(props.code))).svg;
}

onMounted(draw);
watch(isDark, draw);
</script>

<template>
  <div class="mermaid-diagram" v-html="svg"></div>
</template>

<style scoped>
.mermaid-diagram {
  margin: 16px 0;
  overflow-x: auto;
}
/* The paragraphs of the page's style must not apply to the labels of a diagram: mermaid measured them without it. */
.mermaid-diagram :deep(p) {
  margin: 0;
  line-height: 1.5;
}
</style>
