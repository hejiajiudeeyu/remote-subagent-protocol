#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen


ROOT_DIR = Path(__file__).resolve().parent.parent
RUN_DIR = ROOT_DIR / ".run" / "playground"
LOG_DIR = RUN_DIR / "logs"
PID_DIR = RUN_DIR / "pids"

DEFAULT_PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWxEgqqgXZkYM47rWV8OKi5EklRlUk/o9zXI5SS2QQmY=
-----END PUBLIC KEY-----"""

DEFAULT_PRIVATE_KEY = """***REMOVED***
***REMOVED***
***REMOVED_PRIVATE_KEY***"""


def load_dotenv_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        os.environ.setdefault(key, value)


def configure_env() -> dict[str, str]:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    PID_DIR.mkdir(parents=True, exist_ok=True)

    load_dotenv_file(ROOT_DIR / ".env")
    load_dotenv_file(ROOT_DIR / ".env.local")

    env = os.environ.copy()
    env.setdefault("PLATFORM_API_BASE_URL", "http://127.0.0.1:8080")
    env.setdefault("BUYER_CONTROLLER_BASE_URL", "http://127.0.0.1:8081")
    env.setdefault("SELLER_CONTROLLER_BASE_URL", "http://127.0.0.1:8082")
    env.setdefault("PLAYGROUND_SITE_PORT", "4173")

    env.setdefault("BOOTSTRAP_SELLER_ID", "seller_foxlab")
    env.setdefault("BOOTSTRAP_SUBAGENT_ID", "foxlab.text.classifier.v1")
    env.setdefault("BOOTSTRAP_DELIVERY_ADDRESS", "local://relay/seller_foxlab/foxlab.text.classifier.v1")
    env.setdefault("BOOTSTRAP_SELLER_API_KEY", "***REMOVED_STATIC_API_KEY***")
    env.setdefault("BOOTSTRAP_SELLER_PUBLIC_KEY_PEM", DEFAULT_PUBLIC_KEY)
    env.setdefault("BOOTSTRAP_SELLER_PRIVATE_KEY_PEM", DEFAULT_PRIVATE_KEY)
    env.setdefault("SELLER_ID", env["BOOTSTRAP_SELLER_ID"])
    env.setdefault("SUBAGENT_IDS", env["BOOTSTRAP_SUBAGENT_ID"])
    env.setdefault("SELLER_SIGNING_PUBLIC_KEY_PEM", env["BOOTSTRAP_SELLER_PUBLIC_KEY_PEM"])
    env.setdefault("SELLER_SIGNING_PRIVATE_KEY_PEM", env["BOOTSTRAP_SELLER_PRIVATE_KEY_PEM"])
    env.setdefault("PLATFORM_API_KEY", env["BOOTSTRAP_SELLER_API_KEY"])
    env.setdefault("SELLER_MAX_HARD_TIMEOUT_S", "300")
    env.setdefault("SELLER_HEARTBEAT_INTERVAL_MS", "30000")

    if not env.get("DATABASE_URL") and not env.get("SQLITE_DATABASE_PATH"):
      env["DATABASE_URL"] = "postgresql://localhost:5432/croc_playground"

    return env


def parse_database_url(url: str) -> tuple[str, int, str]:
    parsed = urlparse(url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 5432
    dbname = parsed.path.lstrip("/") or "postgres"
    return host, port, dbname


def command_exists(cmd: str) -> bool:
    return subprocess.run(["/usr/bin/env", "bash", "-lc", f"command -v {cmd} >/dev/null"], cwd=ROOT_DIR).returncode == 0


def port_accepting(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def run_quiet(cmd: list[str], env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=ROOT_DIR, env=env, text=True, capture_output=True)


def ensure_postgres_ready(env: dict[str, str]) -> None:
    db_url = env["DATABASE_URL"]
    postgres_bin_dir = env.get("POSTGRES_BIN_DIR", "/opt/homebrew/opt/postgresql@16/bin")
    pg_isready_bin = env.get("PG_ISREADY_BIN", str(Path(postgres_bin_dir) / "pg_isready"))
    psql_bin = env.get("PSQL_BIN", str(Path(postgres_bin_dir) / "psql"))

    if not Path(pg_isready_bin).exists() or not Path(psql_bin).exists():
        raise SystemExit("[playground] PostgreSQL client tools not found. Set SQLITE_DATABASE_PATH or install PostgreSQL.")

    host, port, dbname = parse_database_url(db_url)
    if not port_accepting(host, port):
        print(f"[playground] PostgreSQL is not accepting connections on {host}:{port}.")
        if command_exists("brew"):
            for formula in ("postgresql@17", "postgresql@16", "postgresql"):
                if run_quiet(["brew", "list", "--formula", formula]).returncode == 0:
                    print(f"[playground] Attempting to start {formula} via brew services...")
                    run_quiet(["brew", "services", "start", formula])
                    time.sleep(2)
                    if port_accepting(host, port):
                        break

    if not port_accepting(host, port):
        raise SystemExit(f"[playground] PostgreSQL is still unavailable at {host}:{port}. Start the database first.")

    check = run_quiet([psql_bin, db_url, "-c", "select current_database();"], env=env)
    if check.returncode != 0:
        admin_url = db_url.rsplit("/", 1)[0] + "/postgres"
        run_quiet([psql_bin, admin_url, "-c", f'CREATE DATABASE "{dbname}";'], env=env)

    print(f"[playground] PostgreSQL ready: {db_url}")


def ensure_sqlite_ready(env: dict[str, str]) -> None:
    sqlite_path = Path(env["SQLITE_DATABASE_PATH"]).expanduser()
    sqlite_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"[playground] SQLite ready: {sqlite_path}")


def ensure_storage_ready(env: dict[str, str]) -> None:
    if env.get("DATABASE_URL"):
        ensure_postgres_ready(env)
    else:
        ensure_sqlite_ready(env)


def is_healthy(url: str) -> bool:
    try:
        with urlopen(url, timeout=1.5) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


def pid_file_for(name: str) -> Path:
    return PID_DIR / f"{name}.pid"


def log_file_for(name: str) -> Path:
    return LOG_DIR / f"{name}.log"


def read_pid(name: str) -> int | None:
    pid_file = pid_file_for(name)
    if not pid_file.exists():
        return None
    try:
        return int(pid_file.read_text().strip())
    except Exception:
        return None


def pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def port_in_use(port: int) -> bool:
    return port_accepting("127.0.0.1", port)


def service_specs(env: dict[str, str]) -> list[dict[str, object]]:
    return [
        {
            "name": "stack",
            "port": 8080,
            "health_urls": {
                "platform": "http://127.0.0.1:8080/healthz",
                "buyer": "http://127.0.0.1:8081/healthz",
                "seller": "http://127.0.0.1:8082/healthz",
            },
            "cmd": ["node", "scripts/playground-stack.mjs"],
            "env": {
                "DATABASE_URL": env.get("DATABASE_URL", ""),
                "SQLITE_DATABASE_PATH": env.get("SQLITE_DATABASE_PATH", ""),
                "PLATFORM_API_BASE_URL": env["PLATFORM_API_BASE_URL"],
                "BUYER_PLATFORM_API_KEY": env.get("BUYER_PLATFORM_API_KEY", ""),
                "BOOTSTRAP_SELLER_ID": env["BOOTSTRAP_SELLER_ID"],
                "BOOTSTRAP_SUBAGENT_ID": env["BOOTSTRAP_SUBAGENT_ID"],
                "BOOTSTRAP_DELIVERY_ADDRESS": env["BOOTSTRAP_DELIVERY_ADDRESS"],
                "BOOTSTRAP_SELLER_API_KEY": env["BOOTSTRAP_SELLER_API_KEY"],
                "BOOTSTRAP_SELLER_PUBLIC_KEY_PEM": env["BOOTSTRAP_SELLER_PUBLIC_KEY_PEM"],
                "BOOTSTRAP_SELLER_PRIVATE_KEY_PEM": env["BOOTSTRAP_SELLER_PRIVATE_KEY_PEM"],
                "SELLER_ID": env["SELLER_ID"],
                "SUBAGENT_IDS": env["SUBAGENT_IDS"],
                "SELLER_SIGNING_PUBLIC_KEY_PEM": env["SELLER_SIGNING_PUBLIC_KEY_PEM"],
                "SELLER_SIGNING_PRIVATE_KEY_PEM": env["SELLER_SIGNING_PRIVATE_KEY_PEM"],
                "SELLER_MAX_HARD_TIMEOUT_S": env["SELLER_MAX_HARD_TIMEOUT_S"],
                "SELLER_HEARTBEAT_INTERVAL_MS": env["SELLER_HEARTBEAT_INTERVAL_MS"],
                "PLATFORM_API_KEY": env["PLATFORM_API_KEY"],
            },
        },
        {
            "name": "site",
            "port": int(env["PLAYGROUND_SITE_PORT"]),
            "health_url": f"http://127.0.0.1:{env['PLAYGROUND_SITE_PORT']}/site/protocol-playground.html",
            "cmd": ["python3", "-m", "http.server", env["PLAYGROUND_SITE_PORT"]],
            "env": {},
        },
    ]


def wait_health(url: str, timeout_s: float = 20.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if is_healthy(url):
            return True
        time.sleep(0.5)
    return False


def spec_health_urls(spec: dict[str, object]) -> list[str]:
    if "health_url" in spec:
        return [str(spec["health_url"])]
    urls = spec.get("health_urls") or {}
    return [str(value) for value in urls.values()]


def spec_is_healthy(spec: dict[str, object]) -> bool:
    urls = spec_health_urls(spec)
    return bool(urls) and all(is_healthy(url) for url in urls)


def wait_spec_health(spec: dict[str, object], timeout_s: float = 20.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if spec_is_healthy(spec):
            return True
        time.sleep(0.5)
    return False


def stream_output(prefix: str, pipe) -> None:
    try:
        for line in iter(pipe.readline, ""):
            if not line:
                break
            print(f"[{prefix}] {line.rstrip()}")
    finally:
        pipe.close()


def start_foreground(env: dict[str, str]) -> int:
    ensure_storage_ready(env)
    processes: list[tuple[str, subprocess.Popen[str]]] = []

    def terminate_all(*_args) -> None:
        print("\n[playground] stopping foreground services...")
        for _, proc in reversed(processes):
            if proc.poll() is None:
                proc.terminate()
        deadline = time.time() + 5
        for _, proc in processes:
            if proc.poll() is None:
                try:
                    proc.wait(timeout=max(0.1, deadline - time.time()))
                except subprocess.TimeoutExpired:
                    proc.kill()
        raise SystemExit(0)

    signal.signal(signal.SIGINT, terminate_all)
    signal.signal(signal.SIGTERM, terminate_all)

    for spec in service_specs(env):
        name = spec["name"]
        port = int(spec["port"])
        health_urls = spec_health_urls(spec)
        health_label = ", ".join(health_urls)
        if name != "site" and spec_is_healthy(spec):
            print(f"[playground] {name} already healthy at {health_label}; skipping")
            continue
        if port_in_use(port):
            print(f"[playground] port {port} already in use; skipping {name}")
            continue

        merged_env = env.copy()
        merged_env.update({k: v for k, v in spec["env"].items() if v})
        proc = subprocess.Popen(
            spec["cmd"],
            cwd=ROOT_DIR,
            env=merged_env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        processes.append((name, proc))
        threading.Thread(target=stream_output, args=(str(name), proc.stdout), daemon=True).start()

        if not wait_spec_health(spec, 20 if name != "site" else 5):
            terminate_all()
        print(f"[playground] {name} healthy at {health_label}")

    print(
        "\n[playground] ready\n"
        "  Platform: http://127.0.0.1:8080\n"
        "  Buyer:    http://127.0.0.1:8081\n"
        "  Seller:   http://127.0.0.1:8082\n"
        f"  Site:     http://127.0.0.1:{env['PLAYGROUND_SITE_PORT']}/site/protocol-playground.html\n"
        "\nPress Ctrl+C to stop all foreground processes."
    )

    while True:
        for name, proc in processes:
            code = proc.poll()
            if code is not None:
                print(f"[playground] {name} exited with code {code}")
                terminate_all()
        time.sleep(0.5)


def start_daemon(env: dict[str, str]) -> int:
    ensure_storage_ready(env)
    for spec in service_specs(env):
        name = str(spec["name"])
        port = int(spec["port"])
        health_urls = spec_health_urls(spec)
        health_label = ", ".join(health_urls)
        pid_file = pid_file_for(name)
        pid = read_pid(name)

        if pid_alive(pid):
            print(f"[playground] {name} already running (pid={pid})")
            continue
        if name != "site" and spec_is_healthy(spec):
            print(f"[playground] {name} already healthy at {health_label}")
            continue
        if port_in_use(port):
            print(f"[playground] port {port} already in use; skipping {name}")
            continue

        merged_env = env.copy()
        merged_env.update({k: v for k, v in spec["env"].items() if v})
        with open(log_file_for(name), "a", encoding="utf-8") as log_fp:
            proc = subprocess.Popen(
                spec["cmd"],
                cwd=ROOT_DIR,
                env=merged_env,
                stdout=log_fp,
                stderr=subprocess.STDOUT,
                text=True,
                start_new_session=True,
            )
        pid_file.write_text(str(proc.pid))
        if not wait_spec_health(spec, 20 if name != "site" else 5):
            raise SystemExit(f"[playground] {name} failed to become healthy; check {log_file_for(name)}")
        print(f"[playground] {name} healthy at {health_label}")

    print(
        "[playground] daemon ready\n"
        f"  Site: http://127.0.0.1:{env['PLAYGROUND_SITE_PORT']}/site/protocol-playground.html\n"
        f"  Logs: {LOG_DIR}\n"
        f"  PIDs: {PID_DIR}"
    )
    return 0


def stop_services() -> int:
    stopped = False
    for pid_file in sorted(PID_DIR.glob("*.pid")):
        name = pid_file.stem
        try:
            pid = int(pid_file.read_text().strip())
        except Exception:
            pid_file.unlink(missing_ok=True)
            continue
        if pid_alive(pid):
            print(f"[playground] stopping {name} (pid={pid})")
            os.kill(pid, signal.SIGTERM)
            deadline = time.time() + 5
            while time.time() < deadline and pid_alive(pid):
                time.sleep(0.2)
            if pid_alive(pid):
                os.kill(pid, signal.SIGKILL)
        pid_file.unlink(missing_ok=True)
        stopped = True

    if not stopped:
        print("[playground] no daemon pid files found")
    return 0


def status_services(env: dict[str, str]) -> int:
    stack_pid = read_pid("stack")
    stack_alive = pid_alive(stack_pid)
    stack_spec = next((spec for spec in service_specs(env) if spec["name"] == "stack"), None)
    site_spec = next((spec for spec in service_specs(env) if spec["name"] == "site"), None)

    if stack_spec:
        for role, health_url in (stack_spec.get("health_urls") or {}).items():
            health = is_healthy(str(health_url))
            print(f"{role:8} pid={stack_pid or '-':>6} alive={'yes' if stack_alive else 'no ':>3} health={'ok' if health else 'no'}")

    if site_spec:
        site_pid = read_pid("site")
        site_alive = pid_alive(site_pid)
        site_health = is_healthy(str(site_spec["health_url"]))
        print(f"{'site':8} pid={site_pid or '-':>6} alive={'yes' if site_alive else 'no ':>3} health={'ok' if site_health else 'no'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage Remote Subagent Protocol playground services.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("start", help="Start playground in foreground and stream logs.")
    sub.add_parser("daemon", help="Start playground in background and write pid/log files.")
    sub.add_parser("stop", help="Stop background playground services.")
    sub.add_parser("status", help="Show current service status.")
    args = parser.parse_args()

    env = configure_env()

    if args.command == "start":
        return start_foreground(env)
    if args.command == "daemon":
        return start_daemon(env)
    if args.command == "stop":
        return stop_services()
    if args.command == "status":
        return status_services(env)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
