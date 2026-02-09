const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { randomUUID } = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const dataFile = path.join(__dirname, "data.json");
const defaultMembers = ["爸爸", "妈妈", "爷爷", "奶奶"];

let state = { members: [], tasks: [] };

const createMember = (name) => ({
  id: randomUUID(),
  name,
  reminderPrefs: {
    enabled: true,
    remind24h: true,
    remind2h: true,
    overdue: true
  }
});

const createTask = ({ content, owners, dueAt, requireConfirm, createdBy }) => ({
  id: randomUUID(),
  content,
  owners,
  dueAt,
  requireConfirm,
  createdBy,
  state: "已指派",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  reminders: {
    remind24hSent: false,
    remind2hSent: false,
    lastOverdueAt: null,
    snoozeUntil: null
  }
});

const saveState = () => {
  fs.writeFileSync(dataFile, JSON.stringify(state, null, 2), "utf8");
};

const loadState = () => {
  if (fs.existsSync(dataFile)) {
    try {
      const raw = fs.readFileSync(dataFile, "utf8");
      const parsed = JSON.parse(raw);
      state = {
        members: Array.isArray(parsed.members) ? parsed.members : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : []
      };
      return;
    } catch (error) {
      state = { members: [], tasks: [] };
    }
  }
  state.members = defaultMembers.map(createMember);
  state.tasks = [];
  saveState();
};

const broadcast = () => {
  io.emit("state:update", state);
};

const getMember = (id) => state.members.find((member) => member.id === id);

const isOwner = (task, memberId) => task.owners.includes(memberId);

const isCreator = (task, memberId) => task.createdBy === memberId;

const activeStates = new Set(["已指派", "已接受", "进行中"]);

loadState();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/state", (req, res) => {
  res.json(state);
});

app.post("/api/members", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) {
    res.status(400).json({ error: "成员名不能为空" });
    return;
  }
  const member = createMember(name);
  state.members.push(member);
  saveState();
  broadcast();
  res.json(member);
});

app.patch("/api/members/:id", (req, res) => {
  const member = getMember(req.params.id);
  if (!member) {
    res.status(404).json({ error: "成员不存在" });
    return;
  }
  const prefs = req.body?.reminderPrefs;
  if (prefs) {
    member.reminderPrefs = {
      enabled: Boolean(prefs.enabled),
      remind24h: Boolean(prefs.remind24h),
      remind2h: Boolean(prefs.remind2h),
      overdue: Boolean(prefs.overdue)
    };
  }
  if (req.body?.name) {
    member.name = String(req.body.name).trim() || member.name;
  }
  saveState();
  broadcast();
  res.json(member);
});

app.post("/api/tasks", (req, res) => {
  const content = String(req.body?.content || "").trim();
  const createdBy = String(req.body?.createdBy || "").trim();
  if (!content || !createdBy) {
    res.status(400).json({ error: "任务内容或创建者不能为空" });
    return;
  }
  const ownerIds = Array.isArray(req.body?.owners) ? req.body.owners : [];
  const owners = ownerIds.filter((id) => getMember(id));
  if (!owners.length) {
    owners.push(createdBy);
  }
  const dueAt = req.body?.dueAt ? new Date(req.body.dueAt).toISOString() : null;
  const requireConfirm = Boolean(req.body?.requireConfirm);
  const task = createTask({ content, owners, dueAt, requireConfirm, createdBy });
  state.tasks.unshift(task);
  saveState();
  broadcast();
  res.json(task);
});

app.patch("/api/tasks/:id", (req, res) => {
  const task = state.tasks.find((item) => item.id === req.params.id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  const actorId = String(req.body?.actorId || "").trim();
  const action = String(req.body?.action || "").trim();
  let changed = false;

  const applyUpdate = () => {
    task.updatedAt = new Date().toISOString();
    saveState();
    broadcast();
    res.json(task);
  };

  if (action === "accept" && isOwner(task, actorId) && task.state === "已指派") {
    task.state = "已接受";
    changed = true;
  }

  if (action === "start" && isOwner(task, actorId) && task.state === "已接受") {
    task.state = "进行中";
    changed = true;
  }

  if (
    action === "complete" &&
    isOwner(task, actorId) &&
    (task.state === "已接受" || task.state === "进行中")
  ) {
    task.state = task.requireConfirm ? "待确认" : "已完成";
    changed = true;
  }

  if (action === "confirm" && isCreator(task, actorId) && task.state === "待确认") {
    task.state = "已完成";
    changed = true;
  }

  if (action === "snooze" && isOwner(task, actorId)) {
    const minutes = Math.max(5, Number(req.body?.minutes || 60));
    task.reminders.snoozeUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    changed = true;
  }

  if (action === "update" && isCreator(task, actorId)) {
    if (req.body?.content) {
      task.content = String(req.body.content).trim();
    }
    if (Array.isArray(req.body?.owners)) {
      const owners = req.body.owners.filter((id) => getMember(id));
      task.owners = owners.length ? owners : task.owners;
    }
    if ("dueAt" in req.body) {
      task.dueAt = req.body.dueAt ? new Date(req.body.dueAt).toISOString() : null;
      task.reminders.remind24hSent = false;
      task.reminders.remind2hSent = false;
      task.reminders.lastOverdueAt = null;
      task.reminders.snoozeUntil = null;
    }
    if ("requireConfirm" in req.body) {
      task.requireConfirm = Boolean(req.body.requireConfirm);
    }
    changed = true;
  }

  if (!changed) {
    res.status(400).json({ error: "动作不允许或无变化" });
    return;
  }

  applyUpdate();
});

io.on("connection", (socket) => {
  socket.on("user:join", (memberId) => {
    if (memberId) {
      socket.join(`member:${memberId}`);
    }
  });
});

const maybeSendReminder = (task, type) => {
  task.owners.forEach((ownerId) => {
    const member = getMember(ownerId);
    if (!member || !member.reminderPrefs?.enabled) {
      return;
    }
    if (type === "remind24h" && !member.reminderPrefs.remind24h) {
      return;
    }
    if (type === "remind2h" && !member.reminderPrefs.remind2h) {
      return;
    }
    if (type === "overdue" && !member.reminderPrefs.overdue) {
      return;
    }
    io.to(`member:${ownerId}`).emit("reminder", { taskId: task.id, type });
  });
};

const reminderTick = () => {
  const now = Date.now();
  let dirty = false;
  state.tasks.forEach((task) => {
    if (!task.dueAt || !activeStates.has(task.state)) {
      return;
    }
    const due = new Date(task.dueAt).getTime();
    if (Number.isNaN(due)) {
      return;
    }
    if (task.reminders.snoozeUntil) {
      const snoozeUntil = new Date(task.reminders.snoozeUntil).getTime();
      if (now < snoozeUntil) {
        return;
      }
      task.reminders.snoozeUntil = null;
      dirty = true;
    }
    const diff = due - now;
    if (diff <= 24 * 60 * 60 * 1000 && !task.reminders.remind24hSent) {
      maybeSendReminder(task, "remind24h");
      task.reminders.remind24hSent = true;
      dirty = true;
    }
    if (diff <= 2 * 60 * 60 * 1000 && !task.reminders.remind2hSent) {
      maybeSendReminder(task, "remind2h");
      task.reminders.remind2hSent = true;
      dirty = true;
    }
    if (diff <= 0) {
      const last = task.reminders.lastOverdueAt
        ? new Date(task.reminders.lastOverdueAt).getTime()
        : 0;
      if (!last || now - last >= 6 * 60 * 60 * 1000) {
        maybeSendReminder(task, "overdue");
        task.reminders.lastOverdueAt = new Date().toISOString();
        dirty = true;
      }
    }
  });
  if (dirty) {
    saveState();
  }
};

setInterval(reminderTick, 60 * 1000);

const port = process.env.PORT || 5173;
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
