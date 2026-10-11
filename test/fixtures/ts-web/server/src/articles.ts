import { Router } from "express";

const router = Router();

router.get("/articles/:slug", (_req, res) => res.json({}));

export default router;
