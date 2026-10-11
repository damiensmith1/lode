<template>
  <main>
    <ArticleCard title="hello" />
    <button @click="save">save</button>
    <router-link :to="{ name: 'article' }">read</router-link>
  </main>
</template>

<script setup lang="ts">
import ArticleCard from "./ArticleCard.vue";
import { useCart } from "./use-cart";

const cart = useCart();

function save() {
  cart.add("1");
}
</script>
