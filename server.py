import json
import os
import queue
import calendar
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse
from uuid import uuid4


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_FILE = ROOT / "data.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        return datetime.fromisoformat(value)
    except Exception:
        return None


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(raw)))
    handler.end_headers()
    handler.wfile.write(raw)


def read_json_body(handler: BaseHTTPRequestHandler) -> Dict[str, Any]:
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}


def safe_path_join(base: Path, rel: str) -> Optional[Path]:
    rel = rel.lstrip("/")
    candidate = (base / rel).resolve()
    if base not in candidate.parents and candidate != base:
        return None
    return candidate


def create_member(name: str) -> Dict[str, Any]:
    return {
        "id": str(uuid4()),
        "name": name,
        "reminderPrefs": {"enabled": True, "remind24h": True, "remind2h": True, "overdue": True},
    }


def normalize_repeat(value: Any) -> Dict[str, str]:
    if isinstance(value, dict):
        value = value.get("type")
    value = str(value or "none").strip().lower()
    if value not in {"none", "daily", "weekly", "monthly"}:
        value = "none"
    return {"type": value}


def create_subtask(content: str) -> Dict[str, Any]:
    return {"id": str(uuid4()), "content": content, "done": False, "createdAt": now_iso(), "doneAt": None}


def extract_mentions(content: str, members: List[Dict[str, Any]]) -> List[str]:
    if not content:
        return []
    found: List[str] = []
    for m in members:
        name = str(m.get("name") or "").strip()
        mid = str(m.get("id") or "").strip()
        if not name or not mid:
            continue
        if f"@{name}" in content and mid not in found:
            found.append(mid)
    return found


def create_comment(author_id: str, content: str, mention_ids: List[str]) -> Dict[str, Any]:
    return {
        "id": str(uuid4()),
        "authorId": author_id,
        "content": content,
        "mentions": mention_ids,
        "createdAt": now_iso(),
    }


def add_months(dt: datetime, months: int) -> datetime:
    month_index = dt.year * 12 + (dt.month - 1) + months
    year = month_index // 12
    month = month_index % 12 + 1
    last_day = calendar.monthrange(year, month)[1]
    day = min(dt.day, last_day)
    return dt.replace(year=year, month=month, day=day)


def next_due(due: datetime, repeat_type: str) -> datetime:
    if repeat_type == "daily":
        return due + timedelta(days=1)
    if repeat_type == "weekly":
        return due + timedelta(weeks=1)
    if repeat_type == "monthly":
        return add_months(due, 1)
    return due


def create_task(
    content: str,
    owners: List[str],
    due_at: Optional[str],
    require_confirm: bool,
    created_by: str,
    repeat: Any = None,
    series_id: Optional[str] = None,
    occurrence: int = 1,
) -> Dict[str, Any]:
    now = now_iso()
    repeat_obj = normalize_repeat(repeat)
    series_id = series_id or (str(uuid4()) if repeat_obj["type"] != "none" else None)
    return {
        "id": str(uuid4()),
        "content": content,
        "owners": owners,
        "dueAt": due_at,
        "repeat": repeat_obj,
        "seriesId": series_id,
        "occurrence": occurrence,
        "requireConfirm": require_confirm,
        "createdBy": created_by,
        "state": "已指派",
        "subtasks": [],
        "comments": [],
        "archivedAt": None,
        "deletedAt": None,
        "createdAt": now,
        "updatedAt": now,
        "reminders": {
            "remind24hSent": False,
            "remind2hSent": False,
            "lastOverdueAt": None,
            "snoozeUntil": None,
        },
    }


class Store:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.state: Dict[str, Any] = {"members": [], "tasks": []}

    def load(self) -> None:
        with self._lock:
            if DATA_FILE.exists():
                try:
                    parsed = json.loads(DATA_FILE.read_text("utf-8"))
                    self.state = {
                        "members": list(parsed.get("members") or []),
                        "tasks": list(parsed.get("tasks") or []),
                    }
                    for task in self.state["tasks"]:
                        task.setdefault("subtasks", [])
                        task.setdefault("comments", [])
                        task.setdefault("archivedAt", None)
                        task.setdefault("deletedAt", None)
                        task["repeat"] = normalize_repeat(task.get("repeat"))
                        if task["repeat"]["type"] != "none":
                            task.setdefault("seriesId", str(uuid4()))
                            task.setdefault("occurrence", 1)
                        else:
                            task.setdefault("seriesId", None)
                            task.setdefault("occurrence", 1)
                        task.setdefault(
                            "reminders",
                            {"remind24hSent": False, "remind2hSent": False, "lastOverdueAt": None, "snoozeUntil": None},
                        )
                    names = {str(m.get("name") or "") for m in self.state["members"]}
                    if not self.state["tasks"] and names == {"爸爸", "妈妈", "我", "外婆"}:
                        default_members = [create_member(name) for name in ["爸爸", "妈妈", "爷爷", "奶奶"]]
                        self.state = {"members": default_members, "tasks": []}
                        self.save()
                    return
                except Exception:
                    pass
            default_members = [create_member(name) for name in ["爸爸", "妈妈", "爷爷", "奶奶"]]
            self.state = {"members": default_members, "tasks": []}
            self.save()

    def save(self) -> None:
        with self._lock:
            DATA_FILE.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), "utf-8")

    def get_member(self, member_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            for m in self.state["members"]:
                if m.get("id") == member_id:
                    return m
            return None

    def get_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            for t in self.state["tasks"]:
                if t.get("id") == task_id:
                    return t
            return None


@dataclass
class SSEClient:
    member_id: str
    q: "queue.Queue[str]"


class SSEHub:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._clients: List[SSEClient] = []

    def add(self, client: SSEClient) -> None:
        with self._lock:
            self._clients.append(client)

    def remove(self, client: SSEClient) -> None:
        with self._lock:
            self._clients = [c for c in self._clients if c is not client]

    def broadcast_event(self, event: str, data: Any) -> None:
        payload = json.dumps(data, ensure_ascii=False)
        msg = f"event: {event}\ndata: {payload}\n\n"
        with self._lock:
            for client in list(self._clients):
                try:
                    client.q.put_nowait(msg)
                except Exception:
                    pass

    def send_to_member(self, member_id: str, event: str, data: Any) -> None:
        payload = json.dumps(data, ensure_ascii=False)
        msg = f"event: {event}\ndata: {payload}\n\n"
        with self._lock:
            for client in list(self._clients):
                if client.member_id != member_id:
                    continue
                try:
                    client.q.put_nowait(msg)
                except Exception:
                    pass


store = Store()
hub = SSEHub()


def broadcast_state() -> None:
    hub.broadcast_event("state_update", store.state)


def is_owner(task: Dict[str, Any], member_id: str) -> bool:
    return member_id in (task.get("owners") or [])


def is_creator(task: Dict[str, Any], member_id: str) -> bool:
    return task.get("createdBy") == member_id


ACTIVE_STATES = {"已指派", "已接受", "进行中"}


def maybe_send_reminder(task: Dict[str, Any], reminder_type: str) -> None:
    for owner_id in task.get("owners") or []:
        member = store.get_member(owner_id)
        if not member:
            continue
        prefs = member.get("reminderPrefs") or {}
        if not prefs.get("enabled", True):
            continue
        if reminder_type == "remind24h" and not prefs.get("remind24h", True):
            continue
        if reminder_type == "remind2h" and not prefs.get("remind2h", True):
            continue
        if reminder_type == "overdue" and not prefs.get("overdue", True):
            continue
        hub.send_to_member(owner_id, "reminder", {"taskId": task.get("id"), "type": reminder_type})


def reminder_loop(stop_event: threading.Event) -> None:
    while not stop_event.is_set():
        time.sleep(60)
        now = datetime.now(timezone.utc)
        dirty = False
        with store._lock:
            for task in store.state["tasks"]:
                if task.get("deletedAt") or task.get("archivedAt"):
                    continue
                if task.get("state") not in ACTIVE_STATES:
                    continue
                due = parse_iso(task.get("dueAt"))
                if not due:
                    continue
                snooze_until = parse_iso((task.get("reminders") or {}).get("snoozeUntil"))
                if snooze_until and now < snooze_until:
                    continue
                if snooze_until and now >= snooze_until:
                    task["reminders"]["snoozeUntil"] = None
                    dirty = True
                diff = due - now
                if diff <= timedelta(hours=24) and not task["reminders"].get("remind24hSent"):
                    maybe_send_reminder(task, "remind24h")
                    task["reminders"]["remind24hSent"] = True
                    dirty = True
                if diff <= timedelta(hours=2) and not task["reminders"].get("remind2hSent"):
                    maybe_send_reminder(task, "remind2h")
                    task["reminders"]["remind2hSent"] = True
                    dirty = True
                if diff <= timedelta(seconds=0):
                    last = parse_iso(task["reminders"].get("lastOverdueAt"))
                    if not last or (now - last) >= timedelta(hours=6):
                        maybe_send_reminder(task, "overdue")
                        task["reminders"]["lastOverdueAt"] = now_iso()
                        dirty = True
        if dirty:
            store.save()


class Handler(BaseHTTPRequestHandler):
    server_version = "HomeTodo/0.1"

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            json_response(self, 200, store.state)
            return
        if parsed.path == "/events":
            self.handle_sse(parsed)
            return
        self.serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/members":
            body = read_json_body(self)
            name = str(body.get("name") or "").strip()
            if not name:
                json_response(self, 400, {"error": "成员名不能为空"})
                return
            member = create_member(name)
            with store._lock:
                store.state["members"].append(member)
                store.save()
            broadcast_state()
            json_response(self, 200, member)
            return
        if parsed.path == "/api/tasks":
            body = read_json_body(self)
            content = str(body.get("content") or "").strip()
            created_by = str(body.get("createdBy") or "").strip()
            if not content or not created_by:
                json_response(self, 400, {"error": "任务内容或创建者不能为空"})
                return
            owners = [str(x) for x in (body.get("owners") or []) if store.get_member(str(x))]
            if not owners and store.get_member(created_by):
                owners = [created_by]
            due_at = body.get("dueAt")
            due_at = parse_iso(due_at).isoformat() if due_at and parse_iso(due_at) else None
            repeat = body.get("repeat")
            repeat_obj = normalize_repeat(repeat)
            if repeat_obj["type"] != "none" and not due_at:
                json_response(self, 400, {"error": "设置重复任务时必须填写截止时间"})
                return
            require_confirm = bool(body.get("requireConfirm"))
            task = create_task(content, owners, due_at, require_confirm, created_by, repeat_obj)
            with store._lock:
                store.state["tasks"].insert(0, task)
                store.save()
            broadcast_state()
            json_response(self, 200, task)
            return
        json_response(self, 404, {"error": "Not found"})

    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/members/"):
            member_id = parsed.path.split("/")[-1]
            member = store.get_member(member_id)
            if not member:
                json_response(self, 404, {"error": "成员不存在"})
                return
            body = read_json_body(self)
            with store._lock:
                if body.get("name"):
                    member["name"] = str(body.get("name") or "").strip() or member["name"]
                prefs = body.get("reminderPrefs")
                if isinstance(prefs, dict):
                    member["reminderPrefs"] = {
                        "enabled": bool(prefs.get("enabled")),
                        "remind24h": bool(prefs.get("remind24h")),
                        "remind2h": bool(prefs.get("remind2h")),
                        "overdue": bool(prefs.get("overdue")),
                    }
                store.save()
            broadcast_state()
            json_response(self, 200, member)
            return

        if parsed.path.startswith("/api/tasks/"):
            task_id = parsed.path.split("/")[-1]
            task = store.get_task(task_id)
            if not task:
                json_response(self, 404, {"error": "任务不存在"})
                return
            body = read_json_body(self)
            actor_id = str(body.get("actorId") or "").strip()
            action = str(body.get("action") or "").strip()
            changed = False
            spawned: Optional[Dict[str, Any]] = None
            with store._lock:
                previous_state = task.get("state")
                if task.get("deletedAt") and action not in {"restore", "purge"}:
                    json_response(self, 400, {"error": "任务已在回收站，无法操作"})
                    return
                if action == "accept" and is_owner(task, actor_id) and task.get("state") == "已指派":
                    task["state"] = "已接受"
                    changed = True
                if action == "start" and is_owner(task, actor_id) and task.get("state") == "已接受":
                    task["state"] = "进行中"
                    changed = True
                if action == "complete" and is_owner(task, actor_id) and task.get("state") in {"已接受", "进行中"}:
                    task["state"] = "待确认" if task.get("requireConfirm") else "已完成"
                    changed = True
                if action == "confirm" and is_creator(task, actor_id) and task.get("state") == "待确认":
                    task["state"] = "已完成"
                    changed = True
                if action == "snooze" and is_owner(task, actor_id):
                    minutes = max(5, int(body.get("minutes") or 60))
                    task["reminders"]["snoozeUntil"] = (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()
                    changed = True
                if (
                    action == "archive"
                    and (is_creator(task, actor_id) or is_owner(task, actor_id))
                    and not task.get("archivedAt")
                    and task.get("state") == "已完成"
                ):
                    task["archivedAt"] = now_iso()
                    changed = True
                if action == "unarchive" and (is_creator(task, actor_id) or is_owner(task, actor_id)) and task.get("archivedAt"):
                    task["archivedAt"] = None
                    changed = True
                if action == "restore" and (is_creator(task, actor_id) or is_owner(task, actor_id)) and task.get("deletedAt"):
                    task["deletedAt"] = None
                    changed = True
                if action == "purge" and (is_creator(task, actor_id) or is_owner(task, actor_id)) and task.get("deletedAt"):
                    store.state["tasks"] = [t for t in store.state["tasks"] if t.get("id") != task_id]
                    store.save()
                    broadcast_state()
                    json_response(self, 200, {"ok": True})
                    return
                if action == "subtask_add" and (is_creator(task, actor_id) or is_owner(task, actor_id)):
                    content = str(body.get("content") or "").strip()
                    if not content:
                        json_response(self, 400, {"error": "子任务内容不能为空"})
                        return
                    task.setdefault("subtasks", []).append(create_subtask(content))
                    changed = True
                if action == "subtask_toggle" and (is_creator(task, actor_id) or is_owner(task, actor_id)):
                    subtask_id = str(body.get("subtaskId") or "").strip()
                    for st in task.get("subtasks") or []:
                        if st.get("id") == subtask_id:
                            st["done"] = not bool(st.get("done"))
                            st["doneAt"] = now_iso() if st["done"] else None
                            changed = True
                            break
                if action == "subtask_delete" and (is_creator(task, actor_id) or is_owner(task, actor_id)):
                    subtask_id = str(body.get("subtaskId") or "").strip()
                    before = len(task.get("subtasks") or [])
                    task["subtasks"] = [st for st in (task.get("subtasks") or []) if st.get("id") != subtask_id]
                    changed = changed or (len(task["subtasks"]) != before)
                if action == "comment" and (is_creator(task, actor_id) or is_owner(task, actor_id)):
                    content = str(body.get("content") or "").strip()
                    if not content:
                        json_response(self, 400, {"error": "评论内容不能为空"})
                        return
                    mention_ids = extract_mentions(content, store.state["members"])
                    comment = create_comment(actor_id, content, mention_ids)
                    task.setdefault("comments", []).append(comment)
                    for mid in mention_ids:
                        if mid != actor_id:
                            member = store.get_member(mid)
                            prefs = (member or {}).get("reminderPrefs") or {}
                            if not prefs.get("enabled", True):
                                continue
                            hub.send_to_member(
                                mid,
                                "mention",
                                {"taskId": task.get("id"), "commentId": comment["id"], "authorId": actor_id, "content": content},
                            )
                    changed = True
                if action == "update" and (is_creator(task, actor_id) or is_owner(task, actor_id)):
                    if body.get("content"):
                        task["content"] = str(body.get("content") or "").strip()
                    if isinstance(body.get("owners"), list):
                        owners = [str(x) for x in body.get("owners") if store.get_member(str(x))]
                        if owners:
                            task["owners"] = owners
                    if "dueAt" in body:
                        due = parse_iso(body.get("dueAt"))
                        task["dueAt"] = due.isoformat() if due else None
                        task["reminders"]["remind24hSent"] = False
                        task["reminders"]["remind2hSent"] = False
                        task["reminders"]["lastOverdueAt"] = None
                        task["reminders"]["snoozeUntil"] = None
                    if "repeat" in body:
                        next_repeat = normalize_repeat(body.get("repeat"))
                        if next_repeat["type"] != "none" and not task.get("dueAt"):
                            json_response(self, 400, {"error": "设置重复任务时必须填写截止时间"})
                            return
                        task["repeat"] = next_repeat
                        if next_repeat["type"] != "none" and not task.get("seriesId"):
                            task["seriesId"] = str(uuid4())
                            task["occurrence"] = 1
                    if "requireConfirm" in body:
                        task["requireConfirm"] = bool(body.get("requireConfirm"))
                    changed = True
                if not changed:
                    json_response(self, 400, {"error": "动作不允许或无变化"})
                    return
                task["updatedAt"] = now_iso()
                if (
                    previous_state != "已完成"
                    and task.get("state") == "已完成"
                    and not task.get("archivedAt")
                    and not task.get("deletedAt")
                ):
                    repeat_type = normalize_repeat(task.get("repeat")).get("type")
                    due = parse_iso(task.get("dueAt"))
                    if repeat_type != "none" and due:
                        next_task = create_task(
                            content=task.get("content") or "",
                            owners=list(task.get("owners") or []),
                            due_at=next_due(due, repeat_type).isoformat(),
                            require_confirm=bool(task.get("requireConfirm")),
                            created_by=str(task.get("createdBy") or ""),
                            repeat=task.get("repeat"),
                            series_id=str(task.get("seriesId") or ""),
                            occurrence=int(task.get("occurrence") or 1) + 1,
                        )
                        if task.get("subtasks"):
                            next_task["subtasks"] = [
                                create_subtask(str(st.get("content") or "")) for st in task.get("subtasks") or []
                            ]
                        store.state["tasks"].insert(0, next_task)
                        spawned = next_task
                store.save()
            broadcast_state()
            json_response(self, 200, {"task": task, "spawned": spawned})
            return

        json_response(self, 404, {"error": "Not found"})

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/tasks/"):
            task_id = parsed.path.split("/")[-1]
            body = read_json_body(self)
            actor_id = str(body.get("actorId") or "").strip()
            with store._lock:
                task = store.get_task(task_id)
                if not task:
                    json_response(self, 404, {"error": "任务不存在"})
                    return
                if not (is_creator(task, actor_id) or is_owner(task, actor_id)):
                    json_response(self, 403, {"error": "无删除权限"})
                    return
                if not task.get("deletedAt"):
                    task["deletedAt"] = now_iso()
                    task["updatedAt"] = now_iso()
                store.save()
            broadcast_state()
            json_response(self, 200, {"ok": True})
            return
        json_response(self, 404, {"error": "Not found"})

    def serve_static(self, request_path: str) -> None:
        if request_path in {"", "/"}:
            request_path = "/index.html"
        file_path = safe_path_join(PUBLIC_DIR, request_path)
        if not file_path or not file_path.exists() or not file_path.is_file():
            self.send_response(404)
            self.end_headers()
            return
        content = file_path.read_bytes()
        content_type = "text/plain; charset=utf-8"
        if file_path.suffix == ".html":
            content_type = "text/html; charset=utf-8"
        elif file_path.suffix == ".css":
            content_type = "text/css; charset=utf-8"
        elif file_path.suffix == ".js":
            content_type = "application/javascript; charset=utf-8"
        elif file_path.suffix == ".json":
            content_type = "application/json; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def handle_sse(self, parsed) -> None:
        params = parse_qs(parsed.query or "")
        member_id = (params.get("memberId") or [""])[0]
        if not member_id:
            self.send_response(400)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(b": connected\n\n")
        self.wfile.flush()

        client = SSEClient(member_id=member_id, q=queue.Queue(maxsize=100))
        hub.add(client)
        try:
            client.q.put_nowait(f"event: state_update\ndata: {json.dumps(store.state, ensure_ascii=False)}\n\n")
            while True:
                try:
                    msg = client.q.get(timeout=25)
                    self.wfile.write(msg.encode("utf-8"))
                    self.wfile.flush()
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
        except Exception:
            pass
        finally:
            hub.remove(client)


def run() -> None:
    store.load()
    stop_event = threading.Event()
    t = threading.Thread(target=reminder_loop, args=(stop_event,), daemon=True)
    t.start()
    port = int(os.environ.get("PORT", "5173"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    try:
        print(f"Server running on http://localhost:{port}")
        httpd.serve_forever()
    finally:
        stop_event.set()
        httpd.server_close()


if __name__ == "__main__":
    run()
