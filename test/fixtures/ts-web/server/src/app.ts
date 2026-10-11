import express from "express";

import api from "./api";
import { listUsers } from "./users";

const app = express();
app.get("/users", listUsers);
app.post("/users", (req, res) => res.json(req.body));
app.use(api);
app.listen(3000);
