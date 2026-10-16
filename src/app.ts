
import jwt from "jsonwebtoken";
import express, {
    type ErrorRequestHandler,
    type RequestHandler,
} from "express";
import { z } from "zod";

export const app = express();

app.use(express.json());

interface Task {
    id: number;
    title: string;
    completed: boolean;
    ownerId: string;
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

export const requireAuth: RequestHandler = (req, res, next) => {
    const authorization = req.get("authorization");
    const match = authorization?.match(/^Bearer\s+(\S+)$/i);

    if (!match) {
        res.set("WWW-Authenticate", "Bearer");
        return res.status(401).json({
            error: "Authentication required",
        });
    }

    const secret = process.env.JWT_SECRET;

    if (!secret || Buffer.byteLength(secret) < 32) {
        console.error(
            "JWT_SECRET environment variable must be set and at least 32 bytes",
        );
        return res.status(500).json({
            error: "Internal server error",
        });
    }

    try {
        const payload = jwt.verify(match[1]!, secret, {
            algorithms: ["HS256"],
        });

        if (
            typeof payload === "string" ||
            typeof payload.sub !== "string" ||
            payload.sub.trim().length === 0 ||
            typeof payload.exp !== "number"
        ) {
            res.set("WWW-Authenticate", "Bearer");
            return res.status(401).json({
                error: "Invalid authentication token",
            });
        }

        res.locals.userId = payload.sub;
        return next();
    } catch {
        res.set("WWW-Authenticate", "Bearer");
        return res.status(401).json({
            error: "Invalid authentication token",
        });
    }
};

app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});

app.get("/tasks", requireAuth, (_req, res) => {
    const userId = res.locals.userId as string;
    const userTasks = tasks
        .filter((task) => task.ownerId === userId)
        .map(({ id, title, completed }) => ({ id, title, completed }));

    return res.json(userTasks);
});

app.post("/tasks", requireAuth, (req, res) => {
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
        ownerId: res.locals.userId as string,
    };

    tasks.push(task);

    return res.status(201).json({
        id: task.id,
        title: task.title,
        completed: task.completed,
    });
});

app.get("/tasks/:id", requireAuth, (req, res) => {
    const idResult = taskIdSchema.safeParse(req.params.id);

    if (!idResult.success) {
        return res.status(400).json({ error: "Invalid task ID" });
    }

    const userId = res.locals.userId as string;
    const task = tasks.find(
        (item) =>
            item.id === idResult.data &&
            item.ownerId === userId,
    );

    // Do not reveal whether another user's task exists.
    if (!task) {
        return res.status(404).json({ error: "Task not found" });
    }

    return res.json({
        id: task.id,
        title: task.title,
        completed: task.completed,
    });
});

// Return JSON for unknown paths and unsupported routes.
app.use((_req, res) => {
    return res.status(404).json({ error: "Not found" });
});

// Preserve appropriate 4xx statuses from Express/body-parser.
export const errorHandler: ErrorRequestHandler = (
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
