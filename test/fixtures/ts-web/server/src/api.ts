import { Router } from "express";

import articles from "./articles";

const api = Router().use(articles);

export default Router().use("/api", api);
