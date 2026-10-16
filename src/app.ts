
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

export const app = express();

app.use(express.json());

interface Task {
    id: number;
    title: string;
    completed: boolean;
}

const tasks: Task[] = [];
let nextId = 1;

const createTaskSchema = z.object({
    title: z.string().trim().min(1).max(200),
});

const taskIdSchema = z.coerce.number().int().positive();

app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});

app.get("/tasks", (_req, res) => {
    res.json(tasks);
});

app.post("/tasks", (req, res) => {
    const result = createTaskSchema.safeParse(req.body);

    if (!result.success) {
        return res.status(400).json({
            error: "Invalid task data",
            details: result.error.issues.map((issue) => ({
                field: issue.path.join("."),
                message: issue.message,
            })),
        });
    }

    const task: Task = {
        id: nextId++,
        title: result.data.title,
        completed: false,
    };

    tasks.push(task);
    return res.status(201).json(task);
});

app.get("/tasks/:id", (req, res) => {
    const idResult = taskIdSchema.safeParse(req.params.id);

    if (!idResult.success) {
        return res.status(400).json({ error: "Invalid task ID" });
    }

    const task = tasks.find((item) => item.id === idResult.data);

    if (!task) {
        return res.status(404).json({ error: "Task not found" });
    }

    return res.json(task);
});

// Return consistent errors without exposing internal details.
app.use(
    (
        err: unknown,
        _req: Request,
        res: Response,
        _next: NextFunction
    ) => {
        if (
            err instanceof SyntaxError &&
            "status" in err &&
            err.status === 400
        ) {
            return res.status(400).json({ error: "Invalid JSON body" });
        }

        return res.status(500).json({ error: "Internal server error" });
    }
);
