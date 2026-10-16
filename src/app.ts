
import express from "express";

export const app = express();

app.use(express.json());

interface Task {
    id: number;
    title: string;
    completed: boolean;
}

const tasks: Task[] = [];
let nextId = 1;

app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});

app.get("/tasks", (_req, res) => {
    res.json(tasks);
});

app.post("/tasks", (req, res) => {
    const task: Task = {
        id: nextId++,
        title: req.body.title,
        completed: false,
    };

    tasks.push(task);
    res.status(201).json(task);
});

app.get("/tasks/:id", (req, res) => {
    const task = tasks.find(
        (item) => item.id === Number(req.params.id)
    );

    if (!task) {
        return res.status(404).json({ error: "Task not found" });
    }

    res.json(task);
});
