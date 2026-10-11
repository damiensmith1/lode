<template>
  <article>{{ title }}</article>
</template>

<script setup lang="ts">
defineProps<{ title: string }>();
</script>
