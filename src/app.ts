
import express, {
    type ErrorRequestHandler,
} from "express";
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

// Accept only canonical positive decimal integers in the URL.
const taskIdSchema = z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .refine(Number.isSafeInteger);

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

// Return JSON for unknown paths and unsupported routes.
app.use((_req, res) => {
    return res.status(404).json({ error: "Not found" });
});

// Preserve appropriate 4xx statuses from Express/body-parser.
const errorHandler: ErrorRequestHandler = (
    err: unknown,
    _req,
    res,
    _next,
) => {
    if (
        err instanceof SyntaxError &&
        "body" in err
    ) {
        return res.status(400).json({
            error: "Invalid JSON body",
        });
    }

    const error =
        typeof err === "object" && err !== null
            ? (err as { status?: unknown; statusCode?: unknown })
            : {};

    const status = error.status ?? error.statusCode;

    if (
        typeof status === "number" &&
        Number.isInteger(status) &&
        status >= 400 &&
        status < 500
    ) {
        return res.status(status).json({
            error:
                status === 413
                    ? "Request body too large"
                    : "Invalid request",
        });
    }

    return res.status(500).json({
        error: "Internal server error",
    });
};

app.use(errorHandler);
