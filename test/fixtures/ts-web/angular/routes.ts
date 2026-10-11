import { ArticleComponent, EditorComponent } from "./components";

export const routes = [
  { path: "article/:slug", component: ArticleComponent },
  {
    path: "editor",
    children: [{ path: ":slug", component: EditorComponent }],
  },
];
