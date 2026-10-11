export const routes = [
  { path: "/", name: "home", component: () => import("./Home.vue") },
  { path: "/article", name: "article", component: () => import("./Article.vue") },
];
